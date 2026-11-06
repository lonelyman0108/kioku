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
  // 默认用的主密钥和写下 secret 时用的不是同一把
  const run = (args: string[], key = randomBytes(32)) =>
    importLore(['--account', 'alice', ...args], {
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
        uri: 'core://kb/wifi',
        content: '无线网的密码',
        sensitivity: 'secret',
      }),
    )
  })

  it('主密钥不对时，不加 --apply 的预演照样打印计划；要同步时打印计划之后才报主密钥不一致', async () => {
    const dry = await run([])
    expect(dry.stderr).toBe('')
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('新建（2 条）')
    expect(dry.stdout).toContain('没有写入任何数据')

    const sync = await run(['--sync'])
    expect(sync.code).toBe(1)
    expect(sync.stdout).toContain('新建（2 条）')
    expect(sync.stderr).toContain('KIOKU_MASTER_KEY 解不开')
  })

  it('--secret 写错又带 --sync：看得到计划和计划的错误，不去核对主密钥', async () => {
    const res = await run(['--sync', '--secret', 'infra://nope'])
    expect(res.code).toBe(2)
    expect(res.stdout).toContain('新建（2 条）')
    expect(res.stderr).toContain('--secret 指定的 infra://nope 在 Lore 里不存在')
    expect(res.stderr).not.toContain('KIOKU_MASTER_KEY')
  })

  // 计划里的一个写入目标：标题、坐标（和 Lore 的 URI 不同时带上来源）、归属 · 敏感级 · 优先级
  const targetLine = (title: string, uri: string, from: string | null, at: string, p: number) =>
    `${title}  ${uri}${from ? ` ← ${from}` : ''}  ${at} · P${p}`
  const router = targetLine('路由器', 'user://infra/router', 'infra://router', '本人 · 私密', 2)
  const vault = targetLine('vault', 'user://infra/vault', 'infra://vault', '本人 · 机密', 2)
  // 下面两条每条要起好几次命令行进程（每次都要 tsx 编译并连库），CI 上几个 worker 并行时加起来超过默认的 5 秒
  const SEVERAL_RUNS = 30_000

  it(
    '计划先给各状态的条数，再按状态分组列出：已导入的只给条数，--verbose 才逐条列出',
    async () => {
      await seedLoreNode(lore, 'infra://router', '# 路由器\n路由器的说明')
      await seedLoreNode(lore, 'infra://vault', '# 保险柜\n密码 hunter2')
      await seedLoreNode(lore, 'infra://empty', '')
      const first = await run([], masterKey)
      expect(first.code).toBe(0)
      expect(first.stdout).toContain('计划：新建 4 条，已导入 0 条，不导入 1 条')
      // 标题取正文第一个 # 标题，坐标之后带上 Lore 的 URI；按 --secret 标的写机密，标题只用标识
      expect(first.stdout).toContain(router)
      expect(first.stdout).toContain(targetLine('agent', 'core://agent', null, '通用 · 公开', 0))
      expect(first.stdout).toContain('不导入（1 条）：\n  infra://empty：正文为空')
      expect(first.stdout).toContain('确认无误后加 --apply 执行：新建 4 条。')

      const applied = await run(['--apply', '--secret', 'infra://vault'], masterKey)
      // 测试库里不一定装了任务队列：排不上向量补齐时命令行只警告这一句（服务下次启动时会补上），别的输出都不该有
      const stray = applied.stderr
        .split('\n')
        .filter(
          (line) => line.trim() && !line.startsWith('没能安排向量补齐') && !/^\s+at /.test(line),
        )
      expect(stray).toEqual([])
      expect(applied.code).toBe(0)
      expect(applied.stdout).toContain(vault)
      expect(applied.stdout).toContain('新建 4 条；已导入、跳过 0 条')

      // 再看计划：导入过的只给条数，不逐条列出
      const again = await run([], masterKey)
      expect(again.code).toBe(0)
      expect(again.stdout).toContain(
        '计划：新建 0 条，已导入 4 条（--verbose 逐条列出），不导入 1 条',
      )
      expect(again.stdout).not.toContain('user://infra/router')
      expect(again.stdout).toContain('确认无误后加 --apply 执行：新建 0 条。')

      // --verbose 逐条列出；之前导入成机密的写机密，标题只用标识（不带 --secret 也一样）
      const verbose = await run(['--verbose'], masterKey)
      expect(verbose.stdout).toContain('计划：新建 0 条，已导入 4 条，不导入 1 条')
      expect(verbose.stdout).toContain('已导入（4 条），不再写入：')
      expect(verbose.stdout).toContain(router)
      expect(verbose.stdout).toContain(vault)
      expect(verbose.stdout).not.toContain('保险柜')

      // --secret 对之前按明文导入的不生效：计划里就提醒，列出来的仍是私密
      const late = await run(['--verbose', '--secret', 'infra://router'], masterKey)
      expect(late.stdout).toContain(
        'infra://router 之前导入过，现在是明文，--secret 对它不生效：请在管理界面把 user://infra/router 改为机密',
      )
      expect(late.stdout).toContain(router)
    },
    SEVERAL_RUNS,
  )

  it(
    '同步也先给条数：要更新的逐条列出标题、坐标与要改的几项，已是最新的只给条数',
    async () => {
      await seedLoreNode(lore, 'infra://router', '# 路由器\n路由器的说明')
      expect((await run(['--apply'], masterKey)).code).toBe(0)
      await lore`insert into memories (node_uuid, content, created_at)
      values ('uuid-infra://router', '# 新路由器\n换了路由器', '2025-05-01T00:00:00Z')`
      const res = await run(['--sync'], masterKey)
      expect(res.code).toBe(0)
      expect(res.stdout).toContain(
        '同步导入过的节点：按 Lore 更新 1 条，已是最新 2 条（--verbose 逐条列出）',
      )
      expect(res.stdout).toContain(
        '按 Lore 更新（1 条）：\n  新路由器  user://infra/router：正文、标题',
      )
      expect(res.stdout).not.toContain('已是最新（')
      expect(res.stdout).toContain('确认无误后加 --apply 执行：新建 0 条、按 Lore 更新 1 条。')
      const verbose = await run(['--sync', '--verbose'], masterKey)
      expect(verbose.stdout).toContain('已是最新（2 条）：')
      expect(verbose.stdout).toContain('agent  core://agent')
    },
    SEVERAL_RUNS,
  )

  it('帮助用坐标、归属与标题的说法', async () => {
    const res = await importLore(['--help'], {})
    expect(res.code).toBe(0)
    expect(res.stdout).toContain('--verbose')
    expect(res.stdout).toContain('标题取正文第一个 # 标题')
    expect(res.stdout).not.toMatch(/分区|空间 owner|导入为 secret/)
  })
})
