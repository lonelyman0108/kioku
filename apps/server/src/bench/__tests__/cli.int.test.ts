import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'
import type { BenchRunResult, LifecycleEvent } from '@kioku/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { withSpace, type Database } from '../../db/client'
import { memories, recallEvents, settings, subjects } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bearer, bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'
import { httpExecutor } from '../httpExecutor'
import { runSteps } from '../runner'

const SERVER_DIR = fileURLToPath(new URL('../../..', import.meta.url))
const FORWARD = fileURLToPath(
  new URL('../../../../../plugins/claude-code/hooks/forward.mjs', import.meta.url),
)
const PROCESS_TIMEOUT = 30_000
const BODY = '这段正文不应该默认打印出来'

interface Exited {
  code: number | null
  stdout: string
  stderr: string
}

// 服务跑在这个进程里，子进程要异步等，同步等会把服务也挡住
async function runProcess(
  args: string[],
  env: Record<string, string | undefined>,
  input?: string,
): Promise<Exited> {
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  child.stdin.end(input ?? '')
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

describe.skipIf(!testDatabaseUrl)('命令行', () => {
  let database: Database
  let deps: Deps
  let app: ReturnType<typeof createApp>
  let server: Server
  let url: string
  let ws: Workspace
  let key: string
  let dir: string
  // 经过这个端口的请求
  let requests: { method: string; path: string }[]
  // 这个路径返回 500：模拟服务内部错误
  let brokenPath: string | null
  const masterKey = randomBytes(32)

  const bench = (args: string[], env: Record<string, string | undefined> = {}) =>
    runProcess(['--import', 'tsx', 'src/cli/bench.ts', ...args], {
      KIOKU_BENCH_KEY: key,
      KIOKU_BENCH_URL: url,
      ...env,
    })
  const scenarioFile = async (steps: unknown[], extra: Record<string, unknown> = {}) => {
    const path = join(dir, `${randomBytes(4).toString('hex')}.json`)
    await writeFile(path, JSON.stringify({ id: 'mine', title: '我的场景', steps, ...extra }))
    return path
  }
  const realCreate = async (body: Record<string, unknown>) => {
    const res = await app.request(
      '/v1/memories',
      jsonRequest('POST', { priority: 2, ...body }, bearer(key)),
    )
    if (res.status !== 201) throw new Error(await res.text())
  }
  const count = (table: typeof memories | typeof subjects | typeof recallEvents) =>
    withSpace(database.db, ws.spaceId, async (tx) => (await tx.select().from(table)).length)

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    app = createApp(deps)
    server = serve({
      fetch: (request) => {
        const path = new URL(request.url).pathname
        requests.push({ method: request.method, path })
        if (path === brokenPath) return Response.json({ error: '服务内部错误' }, { status: 500 })
        return app.fetch(request)
      },
      port: 0,
      hostname: '127.0.0.1',
    }) as Server
    if (!server.listening) await once(server, 'listening')
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await database?.close()
  })
  beforeEach(async () => {
    requests = []
    brokenPath = null
    await resetDatabase(database)
    await database.db.delete(settings)
    ws = await bootstrap(app)
    const appId = (await ws.createApp('cc', { runtimeFamily: 'claudecode' })).id
    key = await ws.issueKey(appId)
    dir = await mkdtemp(join(tmpdir(), 'kioku-bench-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('退出码与输出', () => {
    it(
      '全部通过时退出码 0，默认只输出步骤名与通过与否，不打印正文；--show-output 才打印',
      async () => {
        await realCreate({ uri: 'notes://x', content: BODY })
        const file = await scenarioFile([
          {
            kind: 'tool',
            label: '读那条记忆',
            tool: 'kioku_get',
            arguments: { uri: 'notes://x' },
            expect: { error: false, contains: [BODY] },
          },
        ])
        const plain = await bench(['--file', file])
        expect(plain.stderr).toBe('')
        expect(plain.code).toBe(0)
        expect(plain.stdout).toContain('握手：kioku')
        expect(plain.stdout).toContain('11 个工具')
        expect(plain.stdout).toContain('通过  读那条记忆')
        expect(plain.stdout).toContain('没有失败的步骤')
        expect(plain.stdout).not.toContain(BODY)

        const shown = await bench(['--file', file, '--show-output'])
        expect(shown.code).toBe(0)
        expect(shown.stdout).toContain(BODY)
      },
      PROCESS_TIMEOUT,
    )

    it(
      '有失败时退出码 1，只输出失败的断言，不打印实际结果',
      async () => {
        await realCreate({ uri: 'notes://x', content: BODY })
        const file = await scenarioFile([
          {
            kind: 'tool',
            label: '断言不成立',
            tool: 'kioku_get',
            arguments: { uri: 'notes://x' },
            expect: { contains: ['没有这句话'] },
          },
          { kind: 'whoami', label: '后面照常跑' },
        ])
        const { code, stdout } = await bench(['--file', file])
        expect(code).toBe(1)
        expect(stdout).toContain('失败  断言不成立')
        expect(stdout).toContain('应包含「没有这句话」')
        expect(stdout).toContain('通过  后面照常跑')
        expect(stdout).toContain('有失败的步骤')
        expect(stdout).not.toContain(BODY)
      },
      PROCESS_TIMEOUT,
    )

    it(
      'capture 取到的值不进默认输出：断言的说明与 label 保留变量的写法，--show-output 才打印',
      async () => {
        const VALUE = 'hunter2-value'
        const file = await scenarioFile([
          {
            kind: 'tool',
            label: '存一个凭据',
            tool: 'kioku_credential_save',
            arguments: { identifier: 'nas', name: 'NAS', values: { password: VALUE } },
          },
          {
            kind: 'tool',
            label: '取值',
            tool: 'kioku_credential',
            arguments: { identifier: 'nas', field: 'password' },
            capture: { pw: '值：' },
          },
          {
            kind: 'tool',
            label: '拿 ${pw} 当查询',
            tool: 'kioku_search',
            arguments: { query: '${pw}' },
            expect: {
              contains: ['没有这句 ${pw}'],
              uris: ['fake://x/${pw}'],
            },
          },
          {
            kind: 'tool',
            label: '回显的不能有 ${pw}',
            tool: 'kioku_credential',
            arguments: { identifier: 'nas', field: 'password' },
            expect: { notContains: ['${pw}'] },
          },
        ])
        const { code, stdout, stderr } = await bench(['--file', file, '--allow-writes'])
        expect(stderr).toBe('')
        expect(code).toBe(1)
        expect(stdout).toContain('失败  拿 ${pw} 当查询')
        expect(stdout).toContain('应包含「没有这句 ${pw}」')
        expect(stdout).toContain('URI 列表应有 fake://x/${pw}')
        expect(stdout).toContain('失败  回显的不能有 ${pw}')
        expect(stdout).toContain('不应包含「${pw}」')
        expect(stdout).not.toContain(VALUE)

        const shown = await bench(['--file', file, '--allow-writes', '--show-output'])
        expect(shown.stdout).toContain(VALUE)
      },
      PROCESS_TIMEOUT,
    )

    it(
      '跳过不算失败',
      async () => {
        const low = await ws.createKey((await ws.createApp('low')).id, {
          readLayers: ['base'],
          writeLayers: [],
          maxSensitivity: 'public',
          admin: false,
        })
        const file = await scenarioFile([
          { kind: 'whoami' },
          { kind: 'boot', label: '要 secret 级', requires: { maxSensitivity: 'secret' } },
        ])
        const { code, stdout } = await bench(['--file', file], { KIOKU_BENCH_KEY: low.key })
        expect(code).toBe(0)
        expect(stdout).toContain('跳过  要 secret 级：这把 Key 的最高敏感级不到 secret')
      },
      PROCESS_TIMEOUT,
    )

    it(
      '权限探测只列结果：被拒的步骤显示报错，不显示通过，也不算进通过；退出码 0',
      async () => {
        const low = await ws.createKey((await ws.createApp('low')).id, {
          readLayers: ['base'],
          writeLayers: [],
          maxSensitivity: 'public',
          admin: false,
        })
        const { code, stdout } = await bench(['--scenario', 'permission-probe', '--allow-writes'], {
          KIOKU_BENCH_KEY: low.key,
        })
        expect(code).toBe(0)
        expect(stdout).toContain('成功  Key 的上限')
        expect(stdout).toContain('报错  写 secret 级')
        expect(stdout).not.toContain('通过  ')
        expect(stdout).not.toMatch(/通过 \d/)
        expect(stdout).toMatch(/成功 \d+，报错 [1-9]\d*，失败 0，跳过 0，没有执行 0/)
        expect(stdout).toContain('没有失败的步骤')
        expect(stdout).not.toContain('全部通过')

        // 同一个场景，能写的 Key 这一步就是成功
        const full = await bench(['--scenario', 'permission-probe', '--allow-writes'])
        expect(full.code).toBe(0)
        expect(full.stdout).toContain('成功  写 secret 级')
        expect(full.stdout).not.toContain('测试台的权限探测写下的')
      },
      PROCESS_TIMEOUT,
    )

    it(
      '只列结果的场景：REST 的报错带状态码，不带正文；内部错误与不成立的断言仍算失败',
      async () => {
        const rejected = await scenarioFile(
          [{ kind: 'lifecycle', label: '不合法的事件', body: { event: 'nope' } }],
          { probe: true },
        )
        const listed = await bench(['--file', rejected])
        expect(listed.code).toBe(0)
        expect(listed.stdout).toContain('报错 400  不合法的事件')
        expect(listed.stdout).toContain('成功 0，报错 1，失败 0')
        expect(listed.stdout).not.toContain('event')

        brokenPath = '/v1/boot'
        const broken = await scenarioFile(
          [
            { kind: 'boot', label: '内部错误的一步' },
            { kind: 'whoami', label: '断言不成立', expect: { contains: ['没有这句话'] } },
            { kind: 'whoami', label: '后面照常列' },
          ],
          { probe: true },
        )
        const failed = await bench(['--file', broken])
        expect(failed.code).toBe(1)
        expect(failed.stdout).toContain('失败  内部错误的一步')
        expect(failed.stdout).toContain('服务内部错误')
        expect(failed.stdout).toContain('失败  断言不成立')
        expect(failed.stdout).toContain('应包含「没有这句话」')
        expect(failed.stdout).toContain('成功  后面照常列')
        expect(failed.stdout).toContain('成功 1，报错 0，失败 2')
        expect(failed.stdout).toContain('有失败的步骤')
      },
      PROCESS_TIMEOUT,
    )

    it(
      'Key 不对或连不上时退出码 1，说明原因；Key 不走命令行参数',
      async () => {
        const wrong = await bench(['--scenario', 'permission-probe'], {
          KIOKU_BENCH_KEY: 'kk_not_a_real_key',
        })
        expect(wrong.code).toBe(1)
        expect(wrong.stderr).toContain('/whoami')
        const refused = await bench(['--scenario', 'permission-probe'], {
          KIOKU_BENCH_URL: 'http://127.0.0.1:1',
        })
        expect(refused.code).toBe(1)
        const missing = await bench([], { KIOKU_BENCH_KEY: '' })
        expect(missing.code).toBe(2)
        expect(missing.stderr).toContain('KIOKU_BENCH_KEY')
        const unknownFlag = await bench(['--key', 'x'])
        expect(unknownFlag.code).toBe(2)
        expect(unknownFlag.stderr).toContain('--key')
      },
      PROCESS_TIMEOUT,
    )

    it(
      '用法错误退出码 2：没有这个预设、场景文件格式不对；--list 不连服务',
      async () => {
        const unknown = await bench(['--scenario', 'nope'])
        expect(unknown.code).toBe(2)
        expect(unknown.stderr).toContain('没有这个内置预设')
        const badFile = join(dir, 'bad.json')
        await writeFile(badFile, JSON.stringify({ id: 'x', title: 't', steps: [{ kind: 'nope' }] }))
        const bad = await bench(['--file', badFile])
        expect(bad.code).toBe(2)
        expect(bad.stderr).toContain('格式不对')
        const notJson = join(dir, 'bad.txt')
        await writeFile(notJson, 'not json')
        expect((await bench(['--file', notJson])).code).toBe(2)
        expect((await bench(['--file', join(dir, 'missing.json')])).code).toBe(2)

        const list = await bench(['--list'], { KIOKU_BENCH_KEY: '', KIOKU_BENCH_URL: '' })
        expect(list.code).toBe(0)
        expect(list.stdout).toContain('memory-crud')
        expect(list.stdout).toContain('claude-code-session（claudecode、codex）')
      },
      PROCESS_TIMEOUT,
    )
  })

  describe('--allow-writes', () => {
    it(
      '场景里有写操作时不加就拒绝，退出码 2，一步也不执行',
      async () => {
        const memoriesBefore = await count(memories)
        const cases: [string[], string][] = [
          [['--scenario', 'memory-crud'], '新建'],
          // 带群聊上下文的读也算：第一次见到的账号会新建对象
          [['--scenario', 'astrbot-group-round'], '会话开始'],
          // 不指定场景时跑这个运行时的全部预设，里面有写的
          [[], 'claude-code-session'],
        ]
        for (const [args, listed] of cases) {
          requests = []
          const { code, stderr } = await bench(args)
          expect(code).toBe(2)
          expect(stderr).toContain('--allow-writes')
          expect(stderr).toContain(listed)
          expect(requests.some((r) => r.path === '/v1/mcp')).toBe(false)
          expect(requests.map((r) => r.path)).toEqual(['/v1/whoami'])
        }
        expect(await count(memories)).toBe(memoriesBefore)
        expect(await count(subjects)).toBe(0)
      },
      PROCESS_TIMEOUT,
    )

    it(
      '只读的场景不用加；取值的 kioku_credential 要加，只列表不用',
      async () => {
        const reading = await scenarioFile([
          { kind: 'boot' },
          { kind: 'tool', tool: 'kioku_list' },
          { kind: 'tool', tool: 'kioku_credential' },
          { kind: 'recall', body: { query: '随便' } },
          { kind: 'recall', body: { query: '随便', context: { chatType: 'cron' } } },
        ])
        expect((await bench(['--file', reading])).code).toBe(0)
        const fetching = await scenarioFile([
          { kind: 'tool', tool: 'kioku_credential', arguments: { identifier: 'nas' } },
        ])
        expect((await bench(['--file', fetching])).code).toBe(2)
        const creating = await scenarioFile([
          {
            kind: 'recall',
            body: {
              query: '随便',
              context: { chatType: 'direct', platform: 'x', sender: { id: 'u' } },
            },
          },
        ])
        expect((await bench(['--file', creating])).code).toBe(2)
        expect(await count(subjects)).toBe(0)
      },
      PROCESS_TIMEOUT,
    )

    describe('运行前判不出来的：event、chatType 写成变量', () => {
      // 只读的一步取到变量；group 的上下文第一次见到时新建对象，能看出真的写了
      const scenario = async (step: unknown) => {
        await realCreate({ uri: 'notes://vars', content: '事件: turn.end\n会话: group' })
        return scenarioFile([
          {
            kind: 'tool',
            label: '取变量',
            tool: 'kioku_get',
            arguments: { uri: 'notes://vars' },
            capture: { e: '事件: ', c: '会话: ' },
          },
          step,
          { kind: 'whoami', label: '后面照常跑' },
        ])
      }
      const GROUP = {
        platform: 'bench',
        group: { id: 'bench-group' },
        sender: { id: 'bench-user' },
      }

      it.each([
        [
          "event: '${e}'",
          {
            kind: 'lifecycle',
            label: '要写的一步',
            body: { event: '${e}', sessionId: 's', user: '你好', reply: '你好呀' },
          },
          '/v1/lifecycle/event',
        ],
        [
          "chatType: '${c}'（/recall）",
          {
            kind: 'recall',
            label: '要写的一步',
            body: { query: '随便', context: { chatType: '${c}', ...GROUP } },
          },
          '/v1/recall',
        ],
        [
          "chatType: '${c}'（生命周期事件）",
          {
            kind: 'lifecycle',
            label: '要写的一步',
            body: {
              event: 'prompt.submit',
              prompt: '随便',
              context: { chatType: '${c}', ...GROUP },
            },
          },
          '/v1/lifecycle/event',
        ],
      ])(
        '%s：不加 --allow-writes 时这一步不发请求，算失败，说明原因',
        async (_, step, path) => {
          const file = await scenario(step)
          const { code, stdout } = await bench(['--file', file])
          expect(code).toBe(1)
          expect(stdout).toContain('通过  取变量')
          expect(stdout).toContain('失败  要写的一步')
          expect(stdout).toContain('--allow-writes')
          expect(stdout).toContain('通过  后面照常跑')
          expect(stdout).toContain('通过 2，失败 1')
          expect(requests.map((r) => r.path)).not.toContain(path)
          expect(await count(subjects)).toBe(0)

          // 加了就发
          requests = []
          await bench(['--file', file, '--allow-writes'])
          expect(requests.map((r) => r.path)).toContain(path)
        },
        PROCESS_TIMEOUT,
      )

      it(
        '展开之后不写的照常执行：cron 上下文',
        async () => {
          await realCreate({ uri: 'notes://vars', content: '会话: cron' })
          const file = await scenarioFile([
            {
              kind: 'tool',
              tool: 'kioku_get',
              arguments: { uri: 'notes://vars' },
              capture: { c: '会话: ' },
            },
            {
              kind: 'recall',
              label: '定时任务',
              body: { query: '随便', context: { chatType: '${c}' } },
              expect: { error: false },
            },
          ])
          const { code, stdout } = await bench(['--file', file])
          expect(stdout).toContain('通过  定时任务')
          expect(code).toBe(0)
          expect(requests.map((r) => r.path)).toContain('/v1/recall')
        },
        PROCESS_TIMEOUT,
      )
    })

    it(
      '加了就真实执行：内置预设全部通过或跳过，退出码 0，这是真实写入与真实的召回事件',
      async () => {
        const { code, stdout, stderr } = await bench(['--allow-writes'])
        expect(stderr).toBe('')
        expect(code).toBe(0)
        expect(stdout).toContain('Claude Code 一次会话（claude-code-session）')
        expect(stdout).toContain('记忆增删改查（memory-crud）')
        expect(stdout).toContain('权限探测（permission-probe）')
        expect(stdout).toContain('凭据流程（credential-flow）')
        expect(stdout).not.toContain('bench-not-a-real-value')
        expect(stdout).not.toContain('失败  ')
        expect(stdout).toContain('没有失败的步骤')
        // 走的是真实接口：写下的都软删除了，也记了召回事件
        expect(await count(memories)).toBeGreaterThan(0)
        await expect.poll(() => count(recallEvents)).toBeGreaterThan(0)
      },
      PROCESS_TIMEOUT,
    )
  })

  describe('真实的客户端', () => {
    it('SDK 的 Client 真实握手，核对 serverInfo 与工具名单；不再每秒重连 GET', async () => {
      const executor = httpExecutor({ url, key })
      try {
        const server = await executor.handshake()
        expect(server.name).toBe('kioku')
        expect(server.tools).toContain('kioku_credential_delete')
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        const gets = requests.filter((r) => r.method === 'GET' && r.path === '/v1/mcp')
        expect(gets).toHaveLength(1)
      } finally {
        await executor.close()
      }
    })

    it('连不上时算内部错误，不抛到运行器外面；Key 无效时 whoami 就报错', async () => {
      const down = httpExecutor({ url: 'http://127.0.0.1:1', key })
      const outcome = await down.execute({ kind: 'tool', tool: 'kioku_boot', arguments: {} })
      expect(outcome).toMatchObject({ isError: true, internalError: true, httpStatus: null })
      const rest = await down.execute({ kind: 'boot' })
      expect(rest).toMatchObject({ isError: true, internalError: true, httpStatus: null })
      await down.close()

      const wrong = httpExecutor({ url, key: 'kk_not_a_real_key' })
      await expect(wrong.whoami()).rejects.toThrow('HTTP 401')
      await wrong.close()
    })

    it('不合法的请求体和接口的错误相同，状态码也在结果里', async () => {
      const executor = httpExecutor({ url, key })
      try {
        const bad = await executor.execute({ kind: 'lifecycle', body: { event: 'nope' } })
        expect(bad).toMatchObject({ isError: true, internalError: false, httpStatus: 400 })
        expect((bad.raw as { error: string }).error).toBe(bad.text)
      } finally {
        await executor.close()
      }
    })

    it(
      '真实 Key 跑一次钩子脚本：additionalContext 就是测试台看到的文字',
      async () => {
        await realCreate({
          uri: 'core://agent',
          content: '钩子要注入的启动节点',
          layer: 'base',
          sensitivity: 'public',
          priority: 0,
        })
        await realCreate({
          uri: 'notes://hook',
          content: '召回用的记忆',
          glossary: ['钩子关键词'],
        })
        const hook = (event: string, input: unknown) =>
          runProcess(
            [FORWARD, event],
            {
              CLAUDE_PLUGIN_OPTION_SERVER_URL: url,
              CLAUDE_PLUGIN_OPTION_API_KEY: key,
            },
            JSON.stringify(input),
          ).then((exited) => {
            expect(exited.code).toBe(0)
            expect(exited.stderr).toBe('')
            return JSON.parse(exited.stdout) as {
              hookSpecificOutput: { hookEventName: string; additionalContext: string }
            }
          })
        const executor = httpExecutor({ url, key })
        const benched = async (body: LifecycleEvent) => {
          const result: BenchRunResult = await runSteps(executor, {
            mode: 'real',
            steps: [{ kind: 'lifecycle', body }],
            replay: [],
            run: 'hook',
          })
          return result.steps[0]!.text
        }
        try {
          const sessionId = 'hook-session'
          const started = await hook('session.start', { session_id: sessionId, cwd: dir })
          expect(started.hookSpecificOutput.hookEventName).toBe('SessionStart')
          expect(started.hookSpecificOutput.additionalContext).toContain('钩子要注入的启动节点')
          expect(started.hookSpecificOutput.additionalContext).toBe(
            await benched({
              event: 'session.start',
              sessionId,
              project: { dirName: basename(dir) },
            }),
          )

          const prompt = '钩子关键词是什么'
          const submitted = await hook('prompt.submit', { session_id: sessionId, prompt })
          expect(submitted.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
          expect(submitted.hookSpecificOutput.additionalContext).toContain('notes://hook')
          expect(submitted.hookSpecificOutput.additionalContext).toBe(
            await benched({ event: 'prompt.submit', sessionId, prompt }),
          )
        } finally {
          await executor.close()
        }
      },
      PROCESS_TIMEOUT,
    )
  })
})
