import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

import {
  CreateCredentialRequest,
  LORE_BACKUP_FORMAT,
  LORE_UPLOAD_MAX_BYTES,
  LoreImportPlan,
  LoreImportResult,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../app'
import { credentialServiceForConsole } from '../../credential/context'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { entryServiceForConsole } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { addMember, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('从 Lore 导入的 HTTP 接口', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let enqueueBackfill: ReturnType<typeof vi.fn<() => void>>
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    enqueueBackfill = vi.fn()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: {
        enqueueEmbed: vi.fn(),
        enqueueBackfill,
        enqueueExtraction: vi.fn(),
        enqueueDream: vi.fn(),
      } as unknown as NonNullable<Parameters<typeof createApp>[0]['jobs']>,
    })
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    enqueueBackfill.mockClear()
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
  })

  const makeBackup = (
    nodes: { uuid: string; domain: string; path: string; content: string; priority?: number }[],
    createdAt = '2026-01-02T00:00:00.000Z',
  ) => ({
    format: LORE_BACKUP_FORMAT,
    created_at: createdAt,
    tables: {
      nodes: nodes.map((n) => ({ uuid: n.uuid, created_at: '2025-03-01T00:00:00Z' })),
      memories: nodes.map((n, i) => ({
        id: String(i + 1),
        node_uuid: n.uuid,
        content: n.content,
        deprecated: false,
        created_at: '2025-04-01T00:00:00Z',
      })),
      edges: nodes.map((n, i) => ({
        id: String(i + 1),
        child_uuid: n.uuid,
        priority: n.priority ?? 2,
        disclosure: null,
      })),
      paths: nodes.map((n, i) => ({
        domain: n.domain,
        path: n.path,
        edge_id: String(i + 1),
        created_at: '2025-03-01T00:00:00Z',
      })),
      glossary_keywords: [],
    },
  })

  const planUrl = (circleId = ws.circleId) => `/v1/circles/${circleId}/lore-import/plan`
  const applyUrl = (circleId = ws.circleId) => `/v1/circles/${circleId}/lore-import/apply`

  it('权限与请求体大小限制：401 / 403 / 413 正确拦截', async () => {
    const emptyBackup = makeBackup([])
    expect(
      (
        await app.request(
          planUrl(),
          jsonRequest('POST', { source: { kind: 'file', backup: emptyBackup } }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await app.request(
          applyUrl(),
          jsonRequest('POST', {
            source: { kind: 'file', backup: emptyBackup },
            fingerprint: 'fp',
            secretUris: [],
            excludeUris: [],
          }),
        )
      ).status,
    ).toBe(401)

    const editor = await addMember(database.db, ws.circleId, 'bob', 'editor')
    const viewer = await addMember(database.db, ws.circleId, 'carol', 'viewer')
    for (const cookie of [editor.cookie, viewer.cookie]) {
      expect(
        (
          await app.request(
            planUrl(),
            jsonRequest('POST', { source: { kind: 'file', backup: emptyBackup } }, { cookie }),
          )
        ).status,
      ).toBe(403)
    }

    // 非实例管理员不能使用 url 拉取；targetCircleId 越权同样 403
    const bobPersonalPlan = await app.request(
      planUrl(editor.personalCircleId),
      jsonRequest(
        'POST',
        { source: { kind: 'url', url: 'http://127.0.0.1:9', token: 't' } },
        { cookie: editor.cookie },
      ),
    )
    expect(bobPersonalPlan.status).toBe(403)

    const crossTargetPlan = await app.request(
      planUrl(editor.personalCircleId),
      jsonRequest(
        'POST',
        {
          source: { kind: 'file', backup: emptyBackup },
          targetCircleId: ws.circleId,
        },
        { cookie: editor.cookie },
      ),
    )
    expect(crossTargetPlan.status).toBe(403)

    // 超出 LORE_UPLOAD_MAX_BYTES 返回 413
    const oversized = JSON.stringify({
      source: {
        kind: 'file',
        backup: makeBackup([
          {
            uuid: 'big',
            domain: 'infra',
            path: 'a',
            content: 'x'.repeat(LORE_UPLOAD_MAX_BYTES + 128 * 1024),
          },
        ]),
      },
    })
    const bigRes = await app.request(planUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'same-origin',
        cookie: ws.cookie,
      },
      body: oversized,
    })
    expect(bigRes.status).toBe(413)
  })

  it('plan -> apply 全流程、个人圈凭据匹配转占位符、409 指纹与旧文件校验、后台补齐触发', async () => {
    const credSvc = await credentialServiceForConsole(
      {
        db: database.db,
        masterKey,
        cookieSecure: false,
        embedder: staticEmbedderSource(null),
        jobs: null,
      },
      ws.personalCircleId,
      ws.accountId,
    )
    const cred = await credSvc.create(
      CreateCredentialRequest.parse({
        identifier: 'router',
        name: '路由器',
        source: { kind: 'new', values: { password: 'my-secret-router-pass' } },
      }),
    )

    const backup = makeBackup(
      [
        { uuid: 'n-soul', domain: 'core', path: 'soul', content: '助手人格', priority: 0 },
        {
          uuid: 'n-claude',
          domain: 'core',
          path: 'agent/claudecode',
          content: '# 规范\n执行规则',
          priority: 0,
        },
        { uuid: 'n-nas', domain: 'infra', path: 'nas', content: 'password: my-secret-router-pass' },
        {
          uuid: 'n-pref',
          domain: 'preferences',
          path: 'shell',
          content: 'password: my-secret-router-pass',
        },
      ],
      '2026-01-10T00:00:00.000Z',
    )

    const planRes = await app.request(
      planUrl(),
      jsonRequest('POST', { source: { kind: 'file', backup } }, { cookie: ws.cookie }),
    )
    expect(planRes.status).toBe(200)
    const plan = LoreImportPlan.parse(await planRes.json())
    expect(plan.nodeCount).toBe(4)

    const nasNode = plan.nodes.find((n) => n.uri === 'infra://nas')!
    expect(nasNode.plaintext).toHaveLength(1)
    expect(nasNode.plaintext[0]!.credential).toMatchObject({
      id: cred.id,
      identifier: 'router',
      field: 'password',
    })

    // 指纹不匹配返 409
    const badFpRes = await app.request(
      applyUrl(),
      jsonRequest(
        'POST',
        {
          source: { kind: 'file', backup },
          fingerprint: 'wrong-fingerprint',
          secretUris: [],
          excludeUris: [],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(badFpRes.status).toBe(409)

    // 正常 apply：infra://nas 转占位符，preferences://shell (internal) 保留明文并报 plaintextKept
    const applyRes = await app.request(
      applyUrl(),
      jsonRequest(
        'POST',
        {
          source: { kind: 'file', backup },
          fingerprint: plan.fingerprint,
          secretUris: [],
          excludeUris: [],
          convertPlaintext: [
            { source: 'infra://nas', index: 0, credentialId: cred.id, field: 'password' },
            { source: 'preferences://shell', index: 0, credentialId: cred.id, field: 'password' },
          ],
        },
        { cookie: ws.cookie },
      ),
    )
    expect(applyRes.status).toBe(200)
    const applied = LoreImportResult.parse(await applyRes.json())
    expect(applied.personaCreated).toBe(true)
    expect(applied.clientsCreated).toEqual(['claudecode'])
    expect(applied.created).toHaveLength(3)
    expect(applied.plaintextConverted).toHaveLength(1)
    expect(applied.plaintextKept).toHaveLength(1)
    expect(enqueueBackfill).toHaveBeenCalledTimes(1)

    // 读回转换后的个人词条，正文已含占位符
    const personalSvc = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.personalCircleId,
      ws.accountId,
    )
    const nasEntry = await personalSvc.get({ id: 'infra://nas' })
    expect(nasEntry.variants[0]!.content).toBe('password: {{cred:router#password}}')

    // 旧文件校验：早于 2026-01-10 的新内容文件不带 confirmStale 时返 409，带 confirmStale 通过
    const olderBackup = makeBackup(
      [{ uuid: 'n-old-extra', domain: 'infra', path: 'old-extra', content: '旧导出的额外条目' }],
      '2026-01-05T00:00:00.000Z',
    )
    const olderPlanRes = await app.request(
      planUrl(),
      jsonRequest('POST', { source: { kind: 'file', backup: olderBackup } }, { cookie: ws.cookie }),
    )
    const olderPlan = LoreImportPlan.parse(await olderPlanRes.json())
    expect(olderPlan.staleSince).toBeTruthy()

    const staleReject = await app.request(
      applyUrl(),
      jsonRequest(
        'POST',
        {
          source: { kind: 'file', backup: olderBackup },
          fingerprint: olderPlan.fingerprint,
          secretUris: [],
          excludeUris: [],
          confirmStale: false,
        },
        { cookie: ws.cookie },
      ),
    )
    expect(staleReject.status).toBe(409)

    const staleOk = await app.request(
      applyUrl(),
      jsonRequest(
        'POST',
        {
          source: { kind: 'file', backup: olderBackup },
          fingerprint: olderPlan.fingerprint,
          secretUris: [],
          excludeUris: [],
          confirmStale: true,
        },
        { cookie: ws.cookie },
      ),
    )
    expect(staleOk.status).toBe(200)
  })

  it('实例管理员可通过 url 从本地 mock Lore 拉取规划并写入', async () => {
    const payload = makeBackup([
      {
        uuid: 'n-remote',
        domain: 'core',
        path: 'agent',
        content: '# 远程规范\n保持测试通过',
        priority: 0,
      },
    ])
    const server = createServer((req, res) => {
      if (
        req.url === '/api/backup?action=export' &&
        req.headers.authorization === 'Bearer lore-tok'
      ) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }
      res.writeHead(401).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      const source = { kind: 'url' as const, url: `http://127.0.0.1:${port}`, token: 'lore-tok' }
      const pRes = await app.request(
        planUrl(),
        jsonRequest('POST', { source }, { cookie: ws.cookie }),
      )
      expect(pRes.status).toBe(200)
      const p = LoreImportPlan.parse(await pRes.json())

      const aRes = await app.request(
        applyUrl(),
        jsonRequest(
          'POST',
          { source, fingerprint: p.fingerprint, secretUris: [], excludeUris: [] },
          { cookie: ws.cookie },
        ),
      )
      expect(aRes.status).toBe(200)
      const applied = LoreImportResult.parse(await aRes.json())
      expect(applied.created).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
