import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { keyIdOf, type Keyring } from '../keyring'
import { checkMasterKey, prepareMasterKey } from '../rotation'
import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { credentials } from '../../db/schema'
import {
  CHAT_LLM_SETTING_KEY,
  EMBEDDING_SETTING_KEY,
  loadResolvedModel,
  saveModelEndpoint,
} from '../../models/store'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'

describe.skipIf(!testDatabaseUrl)('主密钥启动校验与同步重封轮换', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('配置旧主密钥后在启动时同步重封托管凭据与模型 API Key，移除旧密钥后仍可正常解密', async () => {
    const oldBytes = randomBytes(32)
    const newBytes = randomBytes(32)
    const oldRing: Keyring = { current: oldBytes, previous: null }
    const rotateRing: Keyring = { current: newBytes, previous: oldBytes }
    const newOnlyRing: Keyring = { current: newBytes, previous: null }
    const wrongRing: Keyring = { current: randomBytes(32), previous: null }

    const oldCreds = new CredentialService(database.db, oldRing)
    const created = await oldCreds.create({
      slug: 'openai-key',
      label: 'OpenAI Key',
      value: 'sk-secret-value-123',
      fields: { org: 'org-test' },
      allowedRealms: ['work'],
    })

    await saveModelEndpoint(database.db, oldRing, EMBEDDING_SETTING_KEY, {
      baseUrl: 'https://api.example.com/v1',
      model: 'text-embedding-3-small',
      apiKey: 'sk-embed-old',
      enabled: true,
    })
    await saveModelEndpoint(database.db, oldRing, CHAT_LLM_SETTING_KEY, {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-chat-old',
      enabled: true,
    })

    // 缺少主密钥或主密钥错误时，启动校验必须拒绝
    await expect(checkMasterKey(database.db, null)).rejects.toThrow(/KIOKU_MASTER_KEY/)
    await expect(prepareMasterKey(database.db, wrongRing)).rejects.toThrow(/无法解开/)

    // 携带新旧双密钥启动：同步重封全部凭据与模型配置
    const rotated = await prepareMasterKey(database.db, rotateRing)
    expect(rotated).toEqual({ rewrappedCredentials: 1, rewrappedSettings: 2 })

    // keyId 已切至新主密钥
    const [credRow] = await database.db.select().from(credentials)
    expect(credRow?.keyId).toBe(keyIdOf(newBytes))

    // 撤下旧主密钥后仍可校验通过并完整解密
    await expect(prepareMasterKey(database.db, newOnlyRing)).resolves.toEqual({
      rewrappedCredentials: 0,
      rewrappedSettings: 0,
    })

    const newCreds = new CredentialService(database.db, newOnlyRing)
    const revealed = await newCreds.reveal(created.id)
    expect(revealed.value).toBe('sk-secret-value-123')
    expect(revealed.fields).toEqual({ org: 'org-test' })

    const resolvedEmbed = await loadResolvedModel(database.db, newOnlyRing, EMBEDDING_SETTING_KEY)
    const resolvedChat = await loadResolvedModel(database.db, newOnlyRing, CHAT_LLM_SETTING_KEY)
    expect(resolvedEmbed?.apiKey).toBe('sk-embed-old')
    expect(resolvedChat?.apiKey).toBe('sk-chat-old')
  })
})
