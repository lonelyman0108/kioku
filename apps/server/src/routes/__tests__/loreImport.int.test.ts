import { randomBytes } from 'node:crypto'

import { LORE_BACKUP_FORMAT, LORE_UPLOAD_MAX_BYTES } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('从 Lore 导入的接口（记忆圈架构适配中）', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey: randomBytes(32),
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
  })

  const emptyBackup = {
    format: LORE_BACKUP_FORMAT,
    created_at: new Date(0).toISOString(),
    tables: {
      nodes: [],
      memories: [],
      edges: [],
      paths: [],
      glossary_keywords: [],
    },
  }

  const planBody = {
    source: { kind: 'file', backup: emptyBackup },
    targetCircleId: undefined as string | undefined,
  }

  const applyBody = {
    source: { kind: 'file', backup: emptyBackup },
    fingerprint: 'fp-1',
    secretUris: [],
    excludeUris: [],
  }

  it('权限与请求体大小：未登录 401、非所有者 403、所有者返回 501、超限返回 413', async () => {
    expect(
      (
        await app.request(
          `/v1/circles/${ws.circleId}/lore-import/plan`,
          jsonRequest('POST', planBody),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(
          `/v1/circles/${ws.circleId}/lore-import/apply`,
          jsonRequest('POST', applyBody),
        )
      ).status,
    ).toBe(401)

    const editor = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const viewer = await addMember(database.db, ws.circleId, 'carol', 'viewer')
    for (const cookie of [editor.cookie, viewer.cookie]) {
      expect(
        (
          await app.request(
            `/v1/circles/${ws.circleId}/lore-import/plan`,
            jsonRequest('POST', planBody, { cookie }),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await app.request(
            `/v1/circles/${ws.circleId}/lore-import/apply`,
            jsonRequest('POST', applyBody, { cookie }),
          )
        ).status,
      ).toBe(403)
    }

    const otherCircle = '00000000-0000-4000-8000-000000000001'
    expect(
      (
        await app.request(
          `/v1/circles/${otherCircle}/lore-import/plan`,
          jsonRequest('POST', planBody, { cookie: ws.cookie }),
        )
      ).status,
    ).toBe(403)

    const planRes = await app.request(
      `/v1/circles/${ws.circleId}/lore-import/plan`,
      jsonRequest('POST', planBody, { cookie: ws.cookie }),
    )
    expect(planRes.status).toBe(501)
    expect((await planRes.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('Lore 迁入工具'),
    })

    const applyRes = await app.request(
      `/v1/circles/${ws.circleId}/lore-import/apply`,
      jsonRequest('POST', applyBody, { cookie: ws.cookie }),
    )
    expect(applyRes.status).toBe(501)

    // 超过上传字节上限时直接拦截为 413
    const oversized = 'x'.repeat(LORE_UPLOAD_MAX_BYTES + 128 * 1024)
    const tooLarge = await app.request(`/v1/circles/${ws.circleId}/lore-import/plan`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        cookie: ws.cookie,
      },
      body: oversized,
    })
    expect(tooLarge.status).toBe(413)
  })
})
