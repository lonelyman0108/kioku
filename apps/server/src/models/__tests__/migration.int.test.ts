import { randomBytes } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { encryptSecret } from '../../crypto/envelope'
import { keyIdOf } from '../../crypto/keyring'
import { prepareMasterKey, rotateMasterKey } from '../../crypto/rotation'
import { type Database } from '../../db/client'
import { settings } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  loadDreamProfiles,
  loadExtractionProfiles,
  loadModelRegistryView,
  loadPrivacyBindingResolved,
  loadResolvedEmbeddingSetups,
  migrateLegacyModelSettings,
  MODEL_BINDINGS_KEY,
  MODEL_PROVIDERS_KEY,
  type StoredBindings,
  type StoredProviders,
} from '../store'

function sealLegacy(secret: string, masterKey: Buffer, aad: string, withKeyId = true) {
  const sealed = encryptSecret(masterKey, secret, aad)
  return {
    ciphertext: sealed.ciphertext.toString('base64'),
    wrappedKey: sealed.wrappedKey.toString('base64'),
    ...(withKeyId ? { keyId: keyIdOf(masterKey) } : {}),
  }
}

describe.skipIf(!testDatabaseUrl)('旧版模型设置迁移与主密钥轮换', () => {
  let database: Database
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
  })

  it('幂等迁移 embedding / extraction / privacy_model，保留旧 aad，无主密钥也能完成结构迁移', async () => {
    await database.db.insert(settings).values([
      {
        key: 'extraction',
        value: {
          baseUrl: 'https://extract.example.com/v1',
          model: 'gpt-extract',
          apiKey: sealLegacy('sk-extract', oldKey, 'settings:extraction'),
        },
      },
      {
        key: 'embedding',
        value: {
          active: {
            model: 'embed-alpha',
            channels: [
              {
                id: 'c1',
                baseUrl: 'https://emb1.example.com/v1',
                model: 'embed-alpha',
                apiKey: sealLegacy('sk-emb-1', oldKey, 'settings:embedding'),
              },
              {
                id: 'c2',
                baseUrl: 'https://emb2.example.com/v1',
                model: 'embed-alpha-mirror',
                apiKey: null,
              },
            ],
          },
          next: {
            model: 'embed-beta',
            channels: [
              {
                id: 'n1',
                baseUrl: 'https://emb-next.example.com/v1',
                model: 'embed-beta',
                apiKey: sealLegacy('sk-emb-next', oldKey, 'settings:embedding'),
              },
            ],
          },
        },
      },
      {
        key: 'privacy_model',
        value: {
          mode: 'http',
          baseUrl: 'https://privacy.example.com',
          apiKey: sealLegacy('sk-priv-http', oldKey, 'settings:privacy_model'),
          minScore: 0.72,
        },
      },
    ])

    await migrateLegacyModelSettings(database.db)
    await migrateLegacyModelSettings(database.db)

    const remaining = await database.db.select().from(settings)
    const keys = remaining.map((r) => r.key).sort()
    expect(keys).toEqual([MODEL_BINDINGS_KEY, MODEL_PROVIDERS_KEY])

    const view = await loadModelRegistryView(database.db)
    expect(view.providers).toHaveLength(4)
    expect(view.bindings.extraction.profileIds).toHaveLength(1)
    expect(view.bindings.dream).toMatchObject({ mode: 'inherit', configured: true })
    expect(view.bindings.privacy).toMatchObject({
      mode: 'http',
      configured: true,
      baseUrl: 'https://privacy.example.com',
      hasApiKey: true,
      minScore: 0.72,
    })

    const extractProfiles = await loadExtractionProfiles(database.db, oldKey)
    expect(extractProfiles).toHaveLength(1)
    expect(extractProfiles[0]).toMatchObject({
      baseUrl: 'https://extract.example.com/v1',
      model: 'gpt-extract',
      apiKey: 'sk-extract',
    })
    expect(await loadDreamProfiles(database.db, oldKey)).toHaveLength(1)

    const embSetups = await loadResolvedEmbeddingSetups(database.db, oldKey)
    expect(embSetups.active?.channels.map((p) => [p.baseUrl, p.apiKey])).toEqual([
      ['https://emb1.example.com/v1', 'sk-emb-1'],
      ['https://emb2.example.com/v1', null],
    ])
    expect(embSetups.next?.channels.map((p) => [p.baseUrl, p.apiKey])).toEqual([
      ['https://emb-next.example.com/v1', 'sk-emb-next'],
    ])

    const priv = await loadPrivacyBindingResolved(database.db, oldKey)
    expect(priv).toEqual({
      mode: 'http',
      baseUrl: 'https://privacy.example.com',
      apiKey: 'sk-priv-http',
      minScore: 0.72,
    })
  })

  it('旧版 privacy_model openai 模式迁移为独立服务商并绑定至 privacy，且随主密钥轮换重包装后保留原 aad 并可用新密钥解密', async () => {
    await database.db.insert(settings).values({
      key: 'privacy_model',
      value: {
        mode: 'openai',
        baseUrl: 'https://llm-priv.example.com/v1',
        model: 'gpt-priv',
        apiKey: sealLegacy('sk-llm-priv', oldKey, 'settings:privacy_model', false),
        minScore: 0.55,
      },
    })

    await prepareMasterKey(database.db, oldKey)
    await migrateLegacyModelSettings(database.db)

    const beforeRotate = await loadPrivacyBindingResolved(database.db, oldKey)
    expect(beforeRotate.mode).toBe('model')
    if (beforeRotate.mode === 'model') {
      expect(beforeRotate.profiles).toHaveLength(1)
      expect(beforeRotate.profiles[0]).toMatchObject({
        baseUrl: 'https://llm-priv.example.com/v1',
        model: 'gpt-priv',
        apiKey: 'sk-llm-priv',
      })
    }

    const rotated = await rotateMasterKey(database.db, { current: newKey, previous: oldKey })
    expect(rotated.rewrapped).toBeGreaterThanOrEqual(1)
    expect(rotated.remaining).toBe(0)

    const [provRow] = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_PROVIDERS_KEY))
    const stored = provRow?.value as StoredProviders
    expect(stored.providers[0]?.apiKey?.aad).toBe('settings:privacy_model')
    expect(stored.providers[0]?.apiKey?.keyId).toBe(keyIdOf(newKey))

    const [bindRow] = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, MODEL_BINDINGS_KEY))
    expect((bindRow?.value as StoredBindings).privacy.mode).toBe('model')

    const afterRotate = await loadPrivacyBindingResolved(database.db, newKey)
    expect(afterRotate.mode).toBe('model')
    if (afterRotate.mode === 'model') {
      expect(afterRotate.profiles[0]?.apiKey).toBe('sk-llm-priv')
    }
  })
})
