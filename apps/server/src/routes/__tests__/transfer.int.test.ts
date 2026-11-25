import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  ImportApplyResponse,
  ImportPreviewResponse,
  KIOKU_EXPORT_FORMAT,
  KiokuExportBundle,
  LORE_BACKUP_FORMAT,
} from '@kioku/contracts'
import { asc } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { entries, entryLinks } from '../../db/schema'
import { EntryService } from '../../memory/service'
import {
  consoleHeaders,
  createOwnerSession,
  createTestApp,
  entryInput,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'

function sampleLoreBackup() {
  const now = '2026-11-24T10:00:00.000Z'
  return {
    format: LORE_BACKUP_FORMAT,
    created_at: now,
    tables: {
      nodes: [
        { uuid: 'n1', created_at: now },
        { uuid: 'n2', created_at: now },
        { uuid: 'n3', created_at: now },
      ],
      edges: [
        { id: 1, child_uuid: 'n1', priority: 0, disclosure: '启动必读' },
        { id: 2, child_uuid: 'n2', priority: 2, disclosure: '排查架构时' },
        { id: 3, child_uuid: 'n3', priority: 3, disclosure: null },
      ],
      paths: [
        { domain: 'core', path: 'agent/claudecode', edge_id: 1, created_at: now },
        { domain: 'projects', path: 'kioku/arch', edge_id: 2, created_at: now },
        { domain: 'preferences', path: 'empty-node', edge_id: 3, created_at: now },
      ],
      memories: [
        {
          id: 10,
          node_uuid: 'n1',
          deprecated: false,
          content:
            '# Claude Code 习惯\n\n使用 pnpm 跑测试，不要写明文密钥 sk-test12345678901234567890。',
          created_at: now,
        },
        {
          id: 11,
          node_uuid: 'n2',
          deprecated: false,
          content: '# Kioku 架构笔记\n\n十二张扁平表。',
          created_at: now,
        },
        {
          id: 12,
          node_uuid: 'n3',
          deprecated: false,
          content: '   ',
          created_at: now,
        },
      ],
      glossary_keywords: [{ node_uuid: 'n2', keyword: 'schema' }],
    },
  }
}

async function startFakeLoreServer(
  token: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url !== '/api/backup?action=export') {
      res.writeHead(404).end('not found')
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(sampleLoreBackup()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

describe.skipIf(!testDatabaseUrl)('数据导入导出与外部 Lore 导入', () => {
  let database: Database
  let fakeLore: { url: string; close: () => Promise<void> }

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeLore = await startFakeLoreServer('lore-secret-token')
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await fakeLore.close()
    await database.close()
  })

  it('导出带口令加密的 Kioku 备份，跨实例预览不泄露明文、导入重封凭据且支持短 ID 重分配与双链重写', async () => {
    const masterKeyA = testMasterKey()
    const masterKeyB = testMasterKey()
    let backfillCalls = 0
    const jobs = {
      enqueueEmbed: () => {},
      enqueueBackfill: async () => {
        backfillCalls++
        return true
      },
      enqueueExtraction: async () => {},
      enqueueDream: async () => 'run-1',
      isDreamRunning: async () => false,
      enqueueCleanup: async () => true,
    }

    const appA = createTestApp(database, { masterKey: masterKeyA, jobs })
    const { cookie: cookieA } = await createOwnerSession(database)
    const credSvcA = new CredentialService(database.db, masterKeyA)
    const entrySvcA = new EntryService(database.db, masterKeyA, credSvcA, null)
    const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

    const first = await entrySvcA.create(
      consoleScope,
      entryInput({
        title: '核心规范',
        content: '使用 {{cred:prod-db}} 连接数据库。',
        isPinned: true,
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
      }),
    )
    const second = await entrySvcA.create(
      consoleScope,
      entryInput({
        title: '关联说明',
        content: `详见 [[${first.entry.shortId}|核心规范]]。`,
      }),
    )
    await credSvcA.create({
      slug: 'prod-db',
      label: '生产库密码',
      description: '仅工作环境',
      allowedRealms: ['work'],
      value: 'SUPER_SECRET_DB_PASS_999',
    })

    // 带口令加密导出
    const exportRes = await appA.request('/v1/console/export', {
      method: 'POST',
      headers: consoleHeaders(cookieA, true),
      body: JSON.stringify({
        format: 'json',
        includeCredentials: true,
        passphrase: 'backup-passphrase-2026',
      }),
    })
    expect(exportRes.status).toBe(200)
    expect(exportRes.headers.get('cache-control')).toBe('no-store')
    const exportedText = await exportRes.text()
    expect(exportedText).not.toContain('SUPER_SECRET_DB_PASS_999')

    const bundle = KiokuExportBundle.parse(JSON.parse(exportedText))
    expect(bundle.format).toBe(KIOKU_EXPORT_FORMAT)
    expect(bundle.entries).toHaveLength(2)
    expect(bundle.encryptedCredentials).toBeTruthy()

    // 模拟另一个干净实例（不同主密钥 masterKeyB）
    await resetDatabase(database)
    const appB = createTestApp(database, { masterKey: masterKeyB, jobs })
    const { cookie: cookieB } = await createOwnerSession(database)

    // 错误口令被拒绝
    const badPassPreview = await appB.request('/v1/console/import/preview', {
      method: 'POST',
      headers: consoleHeaders(cookieB, true),
      body: JSON.stringify({
        source: {
          kind: 'kioku',
          bundle,
          includeCredentials: true,
          passphrase: 'wrong-passphrase-1234',
        },
      }),
    })
    expect(badPassPreview.status).toBe(400)

    // 正确口令预览：仅返回凭据元数据，绝不包含明文
    const previewRes = await appB.request('/v1/console/import/preview', {
      method: 'POST',
      headers: consoleHeaders(cookieB, true),
      body: JSON.stringify({
        source: {
          kind: 'kioku',
          bundle,
          includeCredentials: true,
          passphrase: 'backup-passphrase-2026',
        },
      }),
    })
    expect(previewRes.status).toBe(200)
    const previewRaw = await previewRes.text()
    expect(previewRaw).not.toContain('SUPER_SECRET_DB_PASS_999')
    const preview = ImportPreviewResponse.parse(JSON.parse(previewRaw))
    expect(preview.credentialsDecrypted).toBe(true)
    expect(preview.credentials).toHaveLength(1)
    expect(preview.credentials[0]?.slug).toBe('prod-db')
    expect(preview.summary.ready).toBe(2)

    // 首次导入：完整保留原短 ID，并用 masterKeyB 重封凭据
    const apply1 = await appB.request('/v1/console/import/apply', {
      method: 'POST',
      headers: consoleHeaders(cookieB, true),
      body: JSON.stringify({
        source: {
          kind: 'kioku',
          bundle,
          includeCredentials: true,
          passphrase: 'backup-passphrase-2026',
        },
        conflictStrategy: 'skip',
      }),
    })
    expect(apply1.status).toBe(200)
    expect(ImportApplyResponse.parse(await apply1.json())).toEqual({
      createdEntries: 2,
      reallocatedEntries: 0,
      skippedEntries: 0,
      createdCredentials: 1,
      skippedCredentials: 0,
    })
    expect(backfillCalls).toBe(1)

    // 用 masterKeyB 解密验证凭据原值一致
    const credSvcB = new CredentialService(database.db, masterKeyB)
    const metas = await credSvcB.list()
    expect(metas).toHaveLength(1)
    const revealed = await credSvcB.reveal(metas[0]!.id)
    expect(revealed.value).toBe('SUPER_SECRET_DB_PASS_999')

    // 再次导入同一备份（skip 策略）：全部跳过，绝不覆盖
    const applySkip = await appB.request('/v1/console/import/apply', {
      method: 'POST',
      headers: consoleHeaders(cookieB, true),
      body: JSON.stringify({
        source: {
          kind: 'kioku',
          bundle,
          includeCredentials: true,
          passphrase: 'backup-passphrase-2026',
        },
        conflictStrategy: 'skip',
      }),
    })
    expect(applySkip.status).toBe(200)
    expect(ImportApplyResponse.parse(await applySkip.json())).toEqual({
      createdEntries: 0,
      reallocatedEntries: 0,
      skippedEntries: 2,
      createdCredentials: 0,
      skippedCredentials: 1,
    })

    // 再次导入同一备份（reallocate 策略）：分配新短 ID 并自动重写正文双链与 entry_links
    const applyRealloc = await appB.request('/v1/console/import/apply', {
      method: 'POST',
      headers: consoleHeaders(cookieB, true),
      body: JSON.stringify({
        source: {
          kind: 'kioku',
          bundle,
          includeCredentials: false,
        },
        conflictStrategy: 'reallocate',
      }),
    })
    expect(applyRealloc.status).toBe(200)
    expect(ImportApplyResponse.parse(await applyRealloc.json())).toEqual({
      createdEntries: 2,
      reallocatedEntries: 2,
      skippedEntries: 0,
      createdCredentials: 0,
      skippedCredentials: 0,
    })

    const allRows = await database.db.select().from(entries).orderBy(asc(entries.createdAt))
    expect(allRows).toHaveLength(4)
    const newFirst = allRows.find(
      (r) => r.title === '核心规范' && r.shortId !== first.entry.shortId,
    )
    const newSecond = allRows.find(
      (r) => r.title === '关联说明' && r.shortId !== second.entry.shortId,
    )
    expect(newFirst).toBeTruthy()
    expect(newSecond?.content).toBe(`详见 [[${newFirst!.shortId}|核心规范]]。`)
    const links = await database.db.select().from(entryLinks)
    expect(
      links.some((l) => l.sourceEntryId === newSecond!.id && l.targetShortId === newFirst!.shortId),
    ).toBe(true)
  })

  it('支持 Lore 文件与在线地址两步导入，正确映射常驻、客户端、项目、主题与明文提醒', async () => {
    const app = createTestApp(database)
    const { cookie } = await createOwnerSession(database)

    // 1. Lore 在线拉取：错误 Token 返回 400
    const badToken = await app.request('/v1/console/import/preview', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        source: { kind: 'lore-url', url: fakeLore.url, token: 'wrong-token' },
      }),
    })
    expect(badToken.status).toBe(400)

    // 2. Lore 在线拉取预览
    const urlPreviewRes = await app.request('/v1/console/import/preview', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        source: { kind: 'lore-url', url: fakeLore.url, token: 'lore-secret-token' },
      }),
    })
    expect(urlPreviewRes.status).toBe(200)
    const preview = ImportPreviewResponse.parse(await urlPreviewRes.json())
    expect(preview.sourceKind).toBe('lore')
    expect(preview.summary).toMatchObject({ total: 3, ready: 2, skipped: 1, conflicts: 0 })

    const claudeItem = preview.items.find((i) => i.sourceRef === 'core://agent/claudecode')!
    expect(claudeItem.isPinned).toBe(true)
    expect(claudeItem.runtimes).toEqual(['claudecode'])
    expect(claudeItem.secretHintLabels).toContain('OpenAI / 服务密钥')

    const archItem = preview.items.find((i) => i.sourceRef === 'projects://kioku/arch')!
    expect(archItem.isPinned).toBe(false)
    expect(archItem.projects).toEqual(['kioku'])
    expect(archItem.topics).toEqual(['arch', 'schema'])

    const emptyItem = preview.items.find((i) => i.sourceRef === 'preferences://empty-node')!
    expect(emptyItem.skippedReason).toBe('节点正文为空')

    // 3. Lore 文件导入（排除其中 1 条）
    const applyRes = await app.request('/v1/console/import/apply', {
      method: 'POST',
      headers: consoleHeaders(cookie, true),
      body: JSON.stringify({
        source: { kind: 'lore-file', backup: sampleLoreBackup() },
        excludeKeys: ['core://agent/claudecode'],
      }),
    })
    expect(applyRes.status).toBe(200)
    expect(ImportApplyResponse.parse(await applyRes.json())).toEqual({
      createdEntries: 1,
      reallocatedEntries: 0,
      skippedEntries: 2,
      createdCredentials: 0,
      skippedCredentials: 0,
    })

    // 4. 再次预览应检测到同名已存在
    const previewAgain = ImportPreviewResponse.parse(
      await (
        await app.request('/v1/console/import/preview', {
          method: 'POST',
          headers: consoleHeaders(cookie, true),
          body: JSON.stringify({
            source: { kind: 'lore-file', backup: sampleLoreBackup() },
          }),
        })
      ).json(),
    )
    expect(previewAgain.items.find((i) => i.sourceRef === 'projects://kioku/arch')?.conflict).toBe(
      'same_title_exists',
    )
  })
})
