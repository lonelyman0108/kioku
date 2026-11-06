import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

import { CreateMemoryRequest } from '@kioku/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { MemoryService } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import { LORE_SCHEMA, seedLoreNode } from '../../testing/loreFixture'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))

// 子进程跑命令行的源码（和测试台命令行的用例一样），连的是这个用例的库
async function importLore(args: string[], env: Record<string, string | undefined>) {
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

describe.skipIf(!testDatabaseUrl)('从 Lore 导入的命令行', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let lore: postgres.Sql
  let ws: Workspace
  const masterKey = randomBytes(32)

  // 命令行按地址连 Lore：库和测试的是同一个，表在 lore_fixture 这个 schema 里
  const loreUrl = () => {
    const url = new URL(testDatabaseUrl!)
    url.searchParams.set('search_path', 'lore_fixture')
    return url.toString()
  }
  // 主密钥和写下 secret 时用的不是同一把
  const run = (args: string[]) =>
    importLore(['--account', 'alice', ...args], {
      DATABASE_URL: testDatabaseUrl!,
      LORE_DATABASE_URL: loreUrl(),
      KIOKU_MASTER_KEY: randomBytes(32).toString('base64'),
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
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    await seedLoreNode(lore, 'core://agent', '工作流约束的正文', { priority: 0 })
    await seedLoreNode(lore, 'infra://nas', '存储服务器的正文')
    ws = await bootstrap(app)
    // 库里有一条加密的记忆，主密钥对不上时才核对得出来
    const service = new MemoryService({
      db: database.db,
      spaceId: ws.spaceId,
      access: consoleAccess('owner', ws.accountId),
      personaId: 'all',
      masterKey,
      actor: { accountId: ws.accountId },
    })
    await service.create(
      CreateMemoryRequest.parse({
        uri: 'kb://wifi',
        content: '无线网的密码',
        layer: 'base',
        sensitivity: 'secret',
      }),
    )
  })

  it('主密钥不对时，不加 --apply 的预演照样打印计划；要同步时打印计划之后才报主密钥不一致', async () => {
    const dry = await run([])
    expect(dry.stderr).toBe('')
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('记忆（2 条）')
    expect(dry.stdout).toContain('没有写入任何数据')

    const sync = await run(['--sync'])
    expect(sync.code).toBe(1)
    expect(sync.stdout).toContain('记忆（2 条）')
    expect(sync.stderr).toContain('KIOKU_MASTER_KEY 解不开')
  })

  it('--secret 写错又带 --sync：看得到计划和计划的错误，不去核对主密钥', async () => {
    const res = await run(['--sync', '--secret', 'infra://nope'])
    expect(res.code).toBe(2)
    expect(res.stdout).toContain('记忆（2 条）')
    expect(res.stderr).toContain('--secret 指定的 infra://nope 在 Lore 里不存在')
    expect(res.stderr).not.toContain('KIOKU_MASTER_KEY')
  })
})
