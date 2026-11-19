import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConsoleCreateEntryRequest } from '@kioku/contracts'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { entryServiceForConsole } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import { exportLore, LORE_SCHEMA, seedLoreNode } from '../../testing/loreFixture'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))
const CLI_TIMEOUT = 60_000

async function runImportLoreCli(args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/importLore.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

describe.skipIf(!testDatabaseUrl)('从 Lore 导入的命令行 import-lore', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let lore: postgres.Sql
  let ws: Workspace
  let tempDir: string
  const masterKey = randomBytes(32)

  const loreUrl = () => {
    const url = new URL(testDatabaseUrl!)
    url.searchParams.set('search_path', 'lore_fixture')
    return url.toString()
  }

  const run = (args: string[], key = randomBytes(32)) =>
    runImportLoreCli(['--account', 'alice', ...args], {
      DATABASE_URL: testDatabaseUrl!,
      LORE_DATABASE_URL: loreUrl(),
      KIOKU_MASTER_KEY: key.toString('base64'),
      KIOKU_MASTER_KEY_PREVIOUS: undefined,
    })

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
    lore = postgres(testDatabaseUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: 'lore_fixture' },
    })
  })

  afterAll(async () => {
    await lore?.unsafe('drop schema if exists lore_fixture cascade')
    await lore?.end()
    await database?.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    tempDir = await mkdtemp(join(tmpdir(), 'kioku-import-lore-'))
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    await seedLoreNode(lore, 'core://agent', '工作流约束的正文', { priority: 0 })
    await seedLoreNode(lore, 'infra://nas', '# NAS 设备\n存储服务器的正文')
    ws = await bootstrap(app)
    const service = await entryServiceForConsole(
      { db: database.db, masterKey, jobs: null },
      ws.circleId,
      ws.accountId,
    )
    await service.create(
      ConsoleCreateEntryRequest.parse({
        title: 'kb-wifi',
        content: '无线网的密码',
        sensitivity: 'secret',
      }),
    )
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it(
    '支持帮助文本与错误退出码，主密钥不对时干跑可读计划、--sync 与写 --secret 时拦截',
    async () => {
      const help = await runImportLoreCli(['--help'], {})
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('kioku-ctl import-lore')
      expect(help.stdout).toContain('记忆圈')
      expect(help.stdout).not.toContain('适配记忆圈架构')

      const badSecret = await run(['--sync', '--secret', 'infra://nope'])
      expect(badSecret.code).toBe(2)
      expect(badSecret.stderr).toContain('--secret 指定的 infra://nope 在 Lore 里不存在')
      expect(badSecret.stderr).not.toContain('KIOKU_MASTER_KEY')

      const dry = await run([])
      expect(dry.code).toBe(0)
      expect(dry.stdout).toContain('新建（2 条）')
      expect(dry.stdout).toContain('没有写入任何数据')

      const syncWrongKey = await run(['--sync'])
      expect(syncWrongKey.code).toBe(1)
      expect(syncWrongKey.stderr).toContain('KIOKU_MASTER_KEY 解不开')
    },
    CLI_TIMEOUT,
  )

  it(
    '支持直连入库、--secret、--file 与 --sync --verbose --apply 全流程',
    async () => {
      await seedLoreNode(lore, 'infra://vault', '# 保险柜\n秘密内容')
      const applied = await run(['--apply', '--secret', 'infra://vault'], masterKey)
      expect(applied.code).toBe(0)
      expect(applied.stdout).toContain('新建 3 条')
      expect(applied.stdout).toContain('vault  infra://vault')
      expect(applied.stdout).not.toContain('保险柜')

      const again = await run([], masterKey)
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('已导入 3 条（--verbose 逐条列出）')

      await lore`insert into memories (node_uuid, content, created_at)
        values ('uuid-infra://nas', '# 新 NAS\n换了硬盘', '2025-05-01T00:00:00Z')`
      const syncPreview = await run(['--sync', '--verbose'], masterKey)
      expect(syncPreview.code).toBe(0)
      expect(syncPreview.stdout).toContain('按 Lore 更新（1 条）：')
      expect(syncPreview.stdout).toContain('新 NAS')

      const syncApplied = await run(['--sync', '--apply'], masterKey)
      expect(syncApplied.code).toBe(0)
      expect(syncApplied.stdout).toContain('同步完成：更新 1 条')

      // 验证 --file 从导出的 JSON 文件导入新节点：旧时间默认拒绝，加 --confirm-stale 通过
      await seedLoreNode(lore, 'infra://from-file', '文件导入节点')
      const exported = await exportLore(lore, '2026-02-01T00:00:00.000Z')
      const jsonFile = join(tempDir, 'lore.json')
      await writeFile(jsonFile, JSON.stringify(exported), 'utf8')
      const staleFile = await runImportLoreCli(
        ['--account', 'alice', '--file', jsonFile, '--apply'],
        {
          DATABASE_URL: testDatabaseUrl!,
          KIOKU_MASTER_KEY: masterKey.toString('base64'),
        },
      )
      expect(staleFile.code).toBe(2)
      const fileApplied = await runImportLoreCli(
        ['--account', 'alice', '--file', jsonFile, '--confirm-stale', '--apply'],
        {
          DATABASE_URL: testDatabaseUrl!,
          KIOKU_MASTER_KEY: masterKey.toString('base64'),
        },
      )
      expect(fileApplied.code).toBe(0)
      expect(fileApplied.stdout).toContain('新建 1 条')
    },
    CLI_TIMEOUT,
  )
})
