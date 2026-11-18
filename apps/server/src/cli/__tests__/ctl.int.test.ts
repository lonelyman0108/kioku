import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConsoleCreateEntryRequest } from '@kioku/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { entryServiceForConsole } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))
const RUN_TIMEOUT = 15_000

async function runCtlProcess(args: string[], env: Record<string, string | undefined> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/ctl.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
  const [code] = (await once(child, 'close')) as [number | null]
  return {
    code,
    stdoutBuffer: Buffer.concat(stdoutChunks),
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  }
}

describe.skipIf(!testDatabaseUrl)('服务端统一运维命令行 kioku-ctl', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let tempDir: string
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })

  afterAll(async () => {
    await database?.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    tempDir = await mkdtemp(join(tmpdir(), 'kioku-ctl-'))
    ws = await bootstrap(app)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it(
    '支持帮助、版本号、help 子命令与未知子命令报错',
    async () => {
      const help = await runCtlProcess(['--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('kioku-ctl <子命令>')
      expect(help.stdout).toContain('status')
      expect(help.stdout).toContain('backup')

      const ver = await runCtlProcess(['--version'])
      expect(ver.code).toBe(0)
      expect(ver.stdout).toContain('kioku-ctl ')

      const subHelp = await runCtlProcess(['help', 'backup'])
      expect(subHelp.code).toBe(0)
      expect(subHelp.stdout).toContain('--out <文件>')

      const unknown = await runCtlProcess(['nope'])
      expect(unknown.code).toBe(2)
      expect(unknown.stderr).toContain('不认识的子命令 nope')
    },
    RUN_TIMEOUT,
  )

  it(
    'status 检查数据库连接、角色、扩展、迁移与主密钥，且不泄露密码',
    async () => {
      const missing = await runCtlProcess(['status'], {
        DATABASE_URL: '',
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: '',
      })
      expect(missing.code).toBe(1)
      expect(missing.stdout).toContain('未配置')

      const service = await entryServiceForConsole(
        { db: database.db, masterKey, jobs: null },
        ws.circleId,
        ws.accountId,
      )
      await service.create(
        ConsoleCreateEntryRequest.parse({
          title: 'ctl-secret',
          content: '测试机密内容',
          sensitivity: 'secret',
        }),
      )

      const wrongKey = randomBytes(32).toString('base64')
      const mismatch = await runCtlProcess(['status', '--json'], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: wrongKey,
      })
      expect(mismatch.code).toBe(1)
      const mismatchJson = JSON.parse(mismatch.stdout) as {
        ready: boolean
        masterKey: { matched: boolean; error: string }
      }
      expect(mismatchJson.ready).toBe(false)
      expect(mismatchJson.masterKey.matched).toBe(false)
      expect(mismatchJson.masterKey.error).toContain('主密钥对不上')

      const masterKeyBase64 = masterKey.toString('base64')
      const ok = await runCtlProcess(['status', '--json'], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKeyBase64,
      })
      expect(ok.code).toBe(0)
      const okJson = JSON.parse(ok.stdout) as {
        ready: boolean
        database: { ready: boolean; pendingMigrations: number; accounts: number; circles: number }
        masterKey: { configured: boolean; matched: boolean }
      }
      expect(okJson.ready).toBe(true)
      expect(okJson.database.ready).toBe(true)
      expect(okJson.database.pendingMigrations).toBe(0)
      expect(okJson.database.accounts).toBe(1)
      expect(okJson.database.circles).toBe(2)
      expect(okJson.masterKey.configured).toBe(true)
      expect(okJson.masterKey.matched).toBe(true)
      expect(ok.stdout).not.toContain(masterKeyBase64)

      const secretPass = 'distinct-secret-db-pass-check'
      const maskedCheck = await runCtlProcess(['status', '--json'], {
        DATABASE_URL: `postgres://appuser:${secretPass}@127.0.0.1:1/kiokudb`,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKeyBase64,
      })
      expect(maskedCheck.code).toBe(1)
      expect(maskedCheck.stdout).not.toContain(secretPass)
      expect(maskedCheck.stderr).not.toContain(secretPass)
      expect(maskedCheck.stdout).not.toContain(masterKeyBase64)

      const box = await runCtlProcess(['status'], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      })
      expect(box.code).toBe(0)
      expect(box.stdout).toContain('Kioku · 服务端诊断')
      expect(box.stdout).toContain('已就绪')
      expect(box.stdout).toContain('已匹配')
    },
    RUN_TIMEOUT,
  )

  it(
    'backup 与 restore 经统一入口可执行完整往返，且 --out - 时标准输出只含备份密文',
    async () => {
      const service = await entryServiceForConsole(
        { db: database.db, masterKey, jobs: null },
        ws.circleId,
        ws.accountId,
      )
      await service.create(
        ConsoleCreateEntryRequest.parse({
          title: 'ctl-roundtrip',
          content: '备份往返内容',
        }),
      )

      const backupFile = join(tempDir, 'instance.backup')
      const backed = await runCtlProcess(['backup', '--out', backupFile], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      })
      expect(backed.code).toBe(0)
      expect(backed.stdout).toContain('备份完成')

      const stdoutBacked = await runCtlProcess(['backup', '--out', '-'], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      })
      expect(stdoutBacked.code).toBe(0)
      expect(stdoutBacked.stderr).toContain('备份完成：已输出到标准输出')
      expect(stdoutBacked.stdout).not.toContain('备份完成')
      expect(stdoutBacked.stdoutBuffer.length).toBeGreaterThan(32)

      await resetDatabase(database)
      const restored = await runCtlProcess(['restore', '--file', backupFile], {
        DATABASE_URL: testDatabaseUrl!,
        KIOKU_DATA_DIR: tempDir,
        KIOKU_MASTER_KEY: masterKey.toString('base64'),
      })
      expect(restored.code).toBe(0)
      expect(restored.stdout).toContain('恢复完成')
      expect(restored.stdout).toContain('写回')
    },
    RUN_TIMEOUT,
  )
})
