import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { serve } from '@hono/node-server'
import {
  LAYERS,
  mayWrite,
  type BenchRunResult,
  type BenchScenario,
  type BenchStep,
  type KeyScopes,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { keyToSimulate } from '../../access/simulate'
import type { Database } from '../../db/client'
import { settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { saveExtractionConfig } from '../../extraction/settings'
import type { Deps, KeyPrincipal } from '../../http/env'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootstrap, type Workspace } from '../../testing/fixtures'
import { httpExecutor } from '../httpExecutor'
import { runBench } from '../inProcess'
import { runSteps } from '../runner'
import { BENCH_SCENARIOS, scenariosForRuntime } from '../scenarios'

const SHARED: KeyScopes['readLayers'] = ['base', 'persona', 'app', 'subject', 'episode']
// 四种 Key：secret 级，以及管理界面签发 Key 的三种预设（apps/web/src/components/keyPresets.ts）
const KEYS: Record<string, KeyScopes> = {
  secret: {
    readLayers: [...LAYERS],
    writeLayers: [...LAYERS],
    maxSensitivity: 'secret',
    admin: false,
  },
  agent: {
    readLayers: [...LAYERS],
    writeLayers: [...LAYERS],
    maxSensitivity: 'private',
    admin: false,
  },
  bot: {
    readLayers: SHARED,
    writeLayers: ['subject', 'episode'],
    maxSensitivity: 'public',
    admin: false,
  },
  readonly: {
    readLayers: [...LAYERS],
    writeLayers: [],
    maxSensitivity: 'private',
    admin: false,
  },
}

// 每个预设配上适用的运行时类型的应用，运行时不限的用 mcp
const runtimeOf = (scenario: BenchScenario) => scenario.runtimes?.[0] ?? 'mcp'

// 每种 Key 上有哪些步骤真的跑了（不是跳过），防止矩阵因为全跳过而失去意义
const failures = (result: BenchRunResult) =>
  result.steps
    .filter((s) => s.status !== 'passed' && s.status !== 'skipped')
    .map((s) => ({
      label: s.label,
      status: s.status,
      assertions: s.assertions.filter((a) => !a.ok).map((a) => a.message),
    }))

describe('内置场景的约定', () => {
  it('有五个预设，id 不重复，按运行时筛得对', () => {
    expect(BENCH_SCENARIOS.map((s) => s.id).sort()).toEqual([
      'astrbot-group-round',
      'claude-code-session',
      'credential-flow',
      'memory-crud',
      'permission-probe',
    ])
    expect(scenariosForRuntime('claudecode').map((s) => s.id)).toContain('claude-code-session')
    expect(scenariosForRuntime('claudecode').map((s) => s.id)).not.toContain('astrbot-group-round')
    expect(scenariosForRuntime('astrbot').map((s) => s.id)).toContain('astrbot-group-round')
    expect(
      scenariosForRuntime('mcp')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['credential-flow', 'memory-crud', 'permission-probe'])
  })

  const writes = BENCH_SCENARIOS.flatMap((s) =>
    s.steps.flatMap((step): [string, BenchStep & { kind: 'tool' }][] =>
      step.kind === 'tool' && step.tool === 'kioku_create' ? [[s.id, step]] : [],
    ),
  )

  it('只写私人层、不用 priority 0，URI 带 ${run}', () => {
    expect(writes.length).toBeGreaterThan(0)
    for (const [id, step] of writes) {
      expect(step.arguments.layer, id).toBe('private')
      expect(step.arguments.priority ?? 2, id).toBeGreaterThan(0)
      expect(step.arguments.uri, id).toContain('${run}')
    }
  })

  it('平台账号用固定值：对象没有删除接口，带 ${run} 的话每跑一次多两个永久的假对象', () => {
    for (const scenario of BENCH_SCENARIOS) {
      for (const step of scenario.steps) {
        if (step.kind !== 'lifecycle' && step.kind !== 'recall') continue
        const context = (step.body as { context?: unknown }).context
        expect(JSON.stringify(context ?? null), scenario.id).not.toContain('${')
      }
    }
  })

  it('权限探测只列结果：不带断言，也不声明前提', () => {
    const probe = BENCH_SCENARIOS.find((s) => s.id === 'permission-probe')!
    expect(probe.probe).toBe(true)
    for (const step of probe.steps) {
      expect(step.expect).toBeUndefined()
      expect(step.requires).toBeUndefined()
    }
  })

  it('对 secret 与凭据的值不断言：进程内打码，命令行不打码', () => {
    const credentials = BENCH_SCENARIOS.find((s) => s.id === 'credential-flow')!
    expect(JSON.stringify(credentials.steps.map((s) => s.expect))).not.toContain(
      'bench-not-a-real-value',
    )
    const crud = BENCH_SCENARIOS.find((s) => s.id === 'memory-crud')!
    expect(JSON.stringify(crud.steps.map((s) => s.expect))).not.toContain('secret 正文')
  })

  it('判定写操作的函数都认得内置场景里的写步骤', () => {
    const astrbot = BENCH_SCENARIOS.find((s) => s.id === 'astrbot-group-round')!
    expect(astrbot.steps.every(mayWrite)).toBe(true)
    const claude = BENCH_SCENARIOS.find((s) => s.id === 'claude-code-session')!
    expect(claude.steps.filter((s) => !mayWrite(s)).map((s) => s.label)).toEqual([
      '会话开始',
      '每轮输入的召回',
      '下一轮召回得到它',
      '读正文',
      '搜得到',
    ])
  })
})

describe.skipIf(!testDatabaseUrl)('内置场景：三种执行方式、四种 Key', () => {
  let database: Database
  let deps: Deps
  let ws: Workspace
  let url: string
  let server: Server
  const masterKey = randomBytes(32)
  // 各运行时的应用
  let apps: Record<string, string>

  beforeAll(async () => {
    database = await openTestDatabase()
    deps = {
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    }
    server = serve({
      fetch: createApp(deps).fetch,
      port: 0,
      hostname: '127.0.0.1',
    }) as Server
    if (!server.listening) await once(server, 'listening')
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    // 实例设置不随 resetDatabase 清掉，留着会挡住别的测试文件保存抽取设置
    await database?.db.delete(settings)
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
    // 配了抽取模型：turn.end 真的进缓冲，不会因为没配而什么都不做
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'fake',
      apiKey: 'x',
    })
    ws = await bootstrap(createApp(deps))
    apps = {}
    for (const runtimeFamily of new Set(BENCH_SCENARIOS.map(runtimeOf))) {
      apps[runtimeFamily] = (await ws.createApp(`app-${runtimeFamily}`, { runtimeFamily })).id
    }
  })

  const keyFor = async (scopes: KeyScopes, scenario: BenchScenario) => {
    const appId = apps[runtimeOf(scenario)]!
    const created = await ws.createKey(appId, scopes)
    const found = await keyToSimulate(
      deps,
      { spaceId: ws.spaceId, appId, keyId: created.id },
      ws.accountId,
    )
    if ('error' in found) throw new Error(found.error)
    return { plain: created.key, principal: found.key as KeyPrincipal }
  }

  // 每种 Key 上应当真的跑过的步骤（不是跳过）：通过或跳过之外，还要确认该跑的跑了
  const ranLabels = (result: BenchRunResult) =>
    result.steps.filter((s) => s.status === 'passed').map((s) => s.label)
  const expectRan = (name: string, scenario: BenchScenario, result: BenchRunResult) => {
    const ran = ranLabels(result)
    if (scenario.id === 'memory-crud') {
      if (name === 'secret') expect(ran).toContain('新建 secret')
      if (name === 'agent') {
        expect(ran).toContain('新建')
        expect(ran).not.toContain('新建 secret')
      }
      if (name === 'bot' || name === 'readonly') expect(ran).toEqual(['读启动基线'])
    }
    if (scenario.id === 'credential-flow') {
      expect(ran.length > 0).toBe(name === 'secret')
    }
    if (scenario.id === 'astrbot-group-round') expect(ran).toHaveLength(scenario.steps.length)
    if (scenario.id === 'permission-probe') expect(ran).toHaveLength(scenario.steps.length)
  }

  describe.each(Object.keys(KEYS))('%s 级的 Key', (name) => {
    it('回滚模式：都是通过或跳过', async () => {
      for (const scenario of BENCH_SCENARIOS) {
        const { principal } = await keyFor(KEYS[name]!, scenario)
        const result = await runBench(deps, principal, ws.accountId, {
          mode: 'rollback',
          steps: scenario.steps,
          replay: [],
        })
        expect(failures(result), scenario.id).toEqual([])
        expect(result.ok).toBe(true)
        expectRan(name, scenario, result)
      }
    }, 20_000)

    it('真实模式：都是通过或跳过', async () => {
      for (const scenario of BENCH_SCENARIOS) {
        const { principal } = await keyFor(KEYS[name]!, scenario)
        const result = await runBench(deps, principal, ws.accountId, {
          mode: 'real',
          steps: scenario.steps,
          replay: [],
        })
        expect(failures(result), scenario.id).toEqual([])
        expect(result.ok).toBe(true)
        expectRan(name, scenario, result)
      }
    }, 20_000)

    it('HTTP：真实握手，都是通过或跳过', async () => {
      for (const scenario of BENCH_SCENARIOS) {
        const { plain } = await keyFor(KEYS[name]!, scenario)
        const executor = httpExecutor({ url, key: plain })
        try {
          const server = await executor.handshake()
          expect(server.name).toBe('kioku')
          const result = await runSteps(executor, {
            mode: 'real',
            steps: scenario.steps,
            replay: [],
            run: randomBytes(4).toString('hex'),
          })
          expect(failures(result), scenario.id).toEqual([])
          expect(result.ok).toBe(true)
          expectRan(name, scenario, result)
        } finally {
          await executor.close()
        }
      }
    }, 20_000)
  })

  it('重放能接上内置场景：第一次的写步骤放进下一次，结果和一次跑完相同', async () => {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === 'memory-crud')!
    const { principal } = await keyFor(KEYS.agent!, scenario)
    const first = await runBench(deps, principal, ws.accountId, {
      mode: 'rollback',
      steps: scenario.steps.slice(0, 4),
      replay: [],
    })
    expect(first.ok).toBe(true)
    const replay = first.steps.flatMap((s) => (s.replay ? [s.replay] : []))
    expect(replay.map((r) => (r.kind === 'tool' ? r.tool : ''))).toEqual([
      'kioku_create',
      'kioku_update',
    ])
    // 重放不再求值：第二次运行的 ${run} 不同，读的是第一次写下的 URI
    const created = replay[0]!
    const uri = created.kind === 'tool' ? created.arguments.uri : null
    const second = await runBench(deps, principal, ws.accountId, {
      mode: 'rollback',
      steps: [
        {
          kind: 'tool',
          tool: 'kioku_get',
          arguments: { uri },
          expect: { contains: ['改过的记忆', '版本: 2'] },
        },
      ],
      replay,
    })
    expect(second.ok).toBe(true)
    expect(second.run).not.toBe(first.run)
  })
})
