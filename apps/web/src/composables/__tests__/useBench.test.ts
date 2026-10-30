import type {
  AppInfo,
  BenchAgentToolCall,
  BenchAgentTurnResult,
  BenchRunResult,
  KeyInfo,
  KeyScopes,
  WhoAmI,
} from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createApp, effectScope, nextTick, reactive, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api/client'
import { APP_REPLACED_NOTICE, KEY_REPLACED_NOTICE } from '../../benchSession'
import { createBench } from '../useBench'

// 路由与接口换成假的，别的都是真的：vue 的响应式、vue-query 的缓存与刷新。
// 这里要看的是这些东西配在一起时的时序：查询读到之前不动地址、刷新之后才判断、运行中途作废
const fakes = vi.hoisted(() => ({
  route: null as unknown,
  router: null as unknown,
  api: {
    apps: vi.fn(),
    keys: vi.fn(),
    benchRun: vi.fn(),
    benchAgentTurn: vi.fn(),
  },
  guard: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => fakes.route,
  useRouter: () => fakes.router,
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))
vi.mock('../useSession', () => ({ useSession: () => ({ me: { data: ref({ id: 'me' }) } }) }))
vi.mock('../unsavedChanges', () => ({ useUnsavedChangesGuard: fakes.guard }))

const SCOPES: KeyScopes = {
  readLayers: ['private'],
  writeLayers: ['private'],
  maxSensitivity: 'private',
  admin: false,
}
const app = (id: string, ownerAccountId = 'me') =>
  ({ id, name: `应用${id}`, ownerAccountId, runtimeFamily: 'claudecode' }) as AppInfo
const liveKey = (id: string) =>
  ({ id, name: `Key${id}`, prefix: id, effectiveScopes: SCOPES }) as KeyInfo
const revokedKey = (id: string) =>
  ({ id, name: `Key${id}`, prefix: id, effectiveScopes: null }) as KeyInfo

// 真实模式跑了一步的结果
const RESULT = {
  run: 'abcd1234',
  mode: 'real',
  ok: true,
  whoami: {} as WhoAmI,
  counts: { passed: 1, failed: 0, skipped: 0, notRun: 0 },
  steps: [
    {
      index: 0,
      label: 'kioku_create',
      kind: 'tool',
      status: 'passed',
      reason: null,
      isError: false,
      internalError: false,
      internalDetail: null,
      httpStatus: null,
      text: '',
      raw: {},
      ms: 1,
      uris: [],
      session: null,
      vectorSkipped: false,
      assertions: [],
      captured: {},
      changes: null,
      replay: null,
    },
  ],
  replayDiverged: null,
} as BenchRunResult

// 地址：query 里 undefined 的项和真的 vue-router 一样去掉。导航和真的一样是异步的
function fakeRouter(query: Record<string, string>) {
  const fullPath = (q: Record<string, string>) => `/spaces/s1/bench?${new URLSearchParams(q)}`
  const route = reactive({
    name: 'bench',
    params: { spaceId: 's1' },
    query,
    fullPath: fullPath(query),
  })
  const router = {
    replace: vi.fn(async (to: { query: Record<string, string | undefined> }) => {
      await Promise.resolve()
      if (route.name !== 'bench') return
      const next = Object.fromEntries(
        Object.entries(to.query).filter((entry): entry is [string, string] => Boolean(entry[1])),
      )
      route.query = next
      route.fullPath = fullPath(next)
    }),
    push: vi.fn(),
  }
  return { route, router }
}

let client: QueryClient
let scope: EffectScope
let fake: ReturnType<typeof fakeRouter>

function start(query: Record<string, string> = {}) {
  fake = fakeRouter(query)
  fakes.route = fake.route
  fakes.router = fake.router
  const vueApp = createApp({})
  vueApp.use(VueQueryPlugin, { queryClient: client })
  scope = effectScope()
  return vueApp.runWithContext(() => scope.run(() => createBench())!)
}

// 把查询、路由、watch 都走完
async function settle() {
  for (let i = 0; i < 10; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
  }
}

const refetchKeys = async () => {
  await client.invalidateQueries({ queryKey: ['keys'] })
  await settle()
}

async function inRealMode() {
  const bench = start()
  await settle()
  bench.confirmReal()
  await settle()
  expect(bench.real.value).toBe(true)
  return bench
}

const STEPS = [{ kind: 'whoami' as const }]
const WHAT = { label: '我的场景', view: 'judged' as const }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// 开始一次运行，运行期间 Key 被吊销（窗口聚焦重新读取）：这次运行作废，回到回滚
async function abandonRun(mode: 'real' | 'rollback') {
  const bench = start()
  await settle()
  if (mode === 'real') bench.confirmReal()
  await settle()
  const run = deferred<BenchRunResult>()
  fakes.api.benchRun.mockReturnValue(run.promise)
  const outcome = bench.execute(STEPS, WHAT)
  await settle()
  expect(bench.running.value).toBe(true)
  fakes.api.keys.mockResolvedValue([liveKey('k2')])
  await refetchKeys()
  expect(bench.running.value).toBe(false)
  expect(bench.real.value).toBe(false)
  return { bench, run, outcome }
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fakes.api.apps.mockReset().mockResolvedValue([app('a1'), app('a2')])
  fakes.api.keys.mockReset().mockResolvedValue([liveKey('k1'), liveKey('k2')])
  fakes.api.benchRun.mockReset()
  fakes.api.benchAgentTurn.mockReset()
  // 和真的一样，注册时就读一次：用到的状态都要在注册之前建好
  fakes.guard.mockReset().mockImplementation((dirty: { value: boolean }) => dirty.value)
})
afterEach(() => {
  scope.stop()
  client.clear()
})

describe('选择写回地址', () => {
  it('地址里没有应用与 Key：把解析出的写回去，用 replace，不进历史', async () => {
    const bench = start()
    await settle()
    expect(fake.route.query).toEqual({ app: 'a1', key: 'k1' })
    expect(fake.router.push).not.toHaveBeenCalled()
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('别的查询参数留着', async () => {
    start({ tab: 'scenarios' })
    await settle()
    expect(fake.route.query).toEqual({ tab: 'scenarios', app: 'a1', key: 'k1' })
  })

  it('带应用与 Key 的链接（模拟器的「在测试台打开」）：不动地址，选中的就是它们', async () => {
    const bench = start({ app: 'a2', key: 'k2' })
    await settle()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.appId.value).toBe('a2')
    expect(bench.keyId.value).toBe('k2')
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('只带应用的链接：那个应用的默认 Key 写回去，应用不变', async () => {
    fakes.api.keys.mockImplementation(async (_space: string, id: string) =>
      id === 'a2' ? [liveKey('k8')] : [liveKey('k1')],
    )
    start({ app: 'a2' })
    await settle()
    expect(fake.route.query).toEqual({ app: 'a2', key: 'k8' })
  })

  it('还没读到的时候不动地址、不提示', async () => {
    fakes.api.keys.mockReturnValue(new Promise(() => {}))
    const bench = start({ app: 'a1', key: 'k-link' })
    await settle()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('读 Key 失败时不动地址、不提示', async () => {
    fakes.api.keys.mockRejectedValue(new Error('读不到'))
    const bench = start({ app: 'a1', key: 'k-link' })
    await settle()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('缓存里的旧列表没有地址里的 Key：等刷新完再判断，不冤枉它', async () => {
    client.setQueryData(['keys', 's1', 'a1'], [liveKey('k1')])
    fakes.api.keys.mockResolvedValue([liveKey('k1'), liveKey('k-new')])
    const bench = start({ app: 'a1', key: 'k-new' })
    await settle()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.keyId.value).toBe('k-new')
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('刷新失败时手上只有旧列表：不判断', async () => {
    client.setQueryData(['keys', 's1', 'a1'], [liveKey('k1')])
    fakes.api.keys.mockRejectedValue(new Error('读不到'))
    const bench = start({ app: 'a1', key: 'k-new' })
    await settle()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('换应用的时候不把上一个应用的 Key 写进地址', async () => {
    fakes.api.keys.mockImplementation(async (_space: string, id: string) =>
      id === 'a2' ? [liveKey('k8')] : [liveKey('k1')],
    )
    const bench = start()
    await settle()
    expect(fake.route.query).toEqual({ app: 'a1', key: 'k1' })
    fake.router.replace.mockClear()
    bench.selectApp('a2')
    await settle()
    const writes = fake.router.replace.mock.calls.map(([to]) => to.query.key)
    expect(writes).not.toContain('k1')
    expect(fake.route.query).toEqual({ app: 'a2', key: 'k8' })
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('离开页面的路上不写地址：路由先变、组件后卸载', async () => {
    const bench = start()
    await settle()
    fake.router.replace.mockClear()
    fake.route.name = 'memories'
    fake.route.query = {}
    fake.route.fullPath = '/spaces/s1/memories'
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(fake.router.replace).not.toHaveBeenCalled()
    expect(bench.selectionNotice.value).toBeNull()
  })
})

describe('默认选中的一变', () => {
  it('别的标签页签发了新 Key，排到前面：选择不变，会话不清', async () => {
    const bench = start()
    await settle()
    const generation = bench.generation.value
    fakes.api.keys.mockResolvedValue([liveKey('k-new'), liveKey('k1'), liveKey('k2')])
    await refetchKeys()
    expect(bench.keyId.value).toBe('k1')
    expect(fake.route.query.key).toBe('k1')
    expect(bench.generation.value).toBe(generation)
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('点侧栏的入口，地址不带参数了：选择不变，会话不清，写回去', async () => {
    const bench = start()
    await settle()
    const generation = bench.generation.value
    fakes.api.keys.mockResolvedValue([liveKey('k-new'), liveKey('k1'), liveKey('k2')])
    await refetchKeys()
    fake.route.query = {}
    fake.route.fullPath = '/spaces/s1/bench'
    await settle()
    expect(bench.keyId.value).toBe('k1')
    expect(fake.route.query).toEqual({ app: 'a1', key: 'k1' })
    expect(bench.generation.value).toBe(generation)
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('默认的 Key 被吊销：换成别的，地址跟着改，提示一次', async () => {
    const bench = start()
    await settle()
    fakes.api.keys.mockResolvedValue([revokedKey('k1'), liveKey('k2')])
    await refetchKeys()
    expect(bench.keyId.value).toBe('k2')
    expect(fake.route.query.key).toBe('k2')
    expect(bench.selectionNotice.value).toBe(KEY_REPLACED_NOTICE)
  })

  it('应用转走了：换成自己的另一个应用，提示一次，Key 不留原来应用的', async () => {
    fakes.api.keys.mockImplementation(async (_space: string, id: string) =>
      id === 'a2' ? [liveKey('k8')] : [liveKey('k1')],
    )
    const bench = start()
    await settle()
    fakes.api.apps.mockResolvedValue([app('a1', 'other'), app('a2')])
    await client.invalidateQueries({ queryKey: ['apps'] })
    await settle()
    expect(bench.appId.value).toBe('a2')
    expect(fake.route.query).toEqual({ app: 'a2', key: 'k8' })
    expect(bench.selectionNotice.value).toBe(APP_REPLACED_NOTICE)
  })
})

describe('选择失效的提示', () => {
  it('链接里的 Key 失效、有别的可换：换了，地址改成实际选择，提示', async () => {
    const bench = start({ app: 'a1', key: 'k-gone' })
    await settle()
    expect(bench.keyId.value).toBe('k1')
    expect(fake.route.query).toEqual({ app: 'a1', key: 'k1' })
    expect(bench.selectionNotice.value).toBe(KEY_REPLACED_NOTICE)
  })

  it('链接里的应用不是自己的：换了，地址里的 Key 也去掉，只提示应用', async () => {
    const bench = start({ app: 'a-other', key: 'k-other' })
    await settle()
    expect(bench.appId.value).toBe('a1')
    expect(fake.route.query).toEqual({ app: 'a1', key: 'k1' })
    expect(bench.selectionNotice.value).toBe(APP_REPLACED_NOTICE)
  })

  it('没有别的有效 Key：不说换了，地址不动', async () => {
    fakes.api.keys.mockResolvedValue([revokedKey('k1')])
    const bench = start({ app: 'a1', key: 'k1' })
    await settle()
    expect(bench.keyId.value).toBeUndefined()
    expect(bench.selectionNotice.value).toBeNull()
    expect(fake.router.replace).not.toHaveBeenCalled()
  })

  it('没有自己的应用：不说换了，地址不动', async () => {
    fakes.api.apps.mockResolvedValue([app('a1', 'other')])
    const bench = start({ app: 'a1' })
    await settle()
    expect(bench.appId.value).toBeUndefined()
    expect(bench.selectionNotice.value).toBeNull()
    expect(fake.router.replace).not.toHaveBeenCalled()
  })

  it('用得上的 Key 回来了才算换：之前选中的失效，现在有了新的', async () => {
    fakes.api.keys.mockResolvedValue([revokedKey('k1')])
    const bench = start({ app: 'a1', key: 'k1' })
    await settle()
    fakes.api.keys.mockResolvedValue([revokedKey('k1'), liveKey('k-new')])
    await refetchKeys()
    expect(bench.keyId.value).toBe('k-new')
    expect(fake.route.query.key).toBe('k-new')
    expect(bench.selectionNotice.value).toBe(KEY_REPLACED_NOTICE)
  })

  it('关掉之后不再提示：地址已经是实际的选择，再刷新也不会', async () => {
    const bench = start({ app: 'a1', key: 'k-gone' })
    await settle()
    bench.selectionNotice.value = null
    await refetchKeys()
    expect(bench.selectionNotice.value).toBeNull()
    expect(fake.router.replace).toHaveBeenCalledTimes(1)
  })

  it('刷新页面：地址已经改过，不再提示', async () => {
    start({ app: 'a1', key: 'k-gone' })
    await settle()
    const { query } = fake.route
    scope.stop()
    const again = start(query)
    await settle()
    expect(again.keyId.value).toBe('k1')
    expect(again.selectionNotice.value).toBeNull()
  })

  it('自己选了别的：提示清掉', async () => {
    const bench = start({ app: 'a1', key: 'k-gone' })
    await settle()
    expect(bench.selectionNotice.value).toBe(KEY_REPLACED_NOTICE)
    bench.selectKey('k2')
    await settle()
    expect(bench.keyId.value).toBe('k2')
    expect(bench.selectionNotice.value).toBeNull()
  })

  it('提示不随换 Key 带来的重置消失：报错会被清掉，靠它说明发生了什么', async () => {
    const bench = start()
    await settle()
    const generation = bench.generation.value
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(bench.generation.value).toBeGreaterThan(generation)
    expect(bench.selectionNotice.value).toBe(KEY_REPLACED_NOTICE)
  })
})

describe('运行中途作废', () => {
  it('真实模式：结果回来时警告可能已经写入，结果留着显示', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.resolve(RESULT)
    expect(await outcome).toEqual({ kind: 'stale' })
    const [record] = bench.abandoned.value
    expect(record?.title).toContain('可能已经写入')
    expect(record?.title).toContain('到活动里确认')
    expect(record?.description).toContain('「我的场景」')
    expect(record?.description).toContain('「应用a1」的 Key「Keyk1」')
    expect(record?.result).toBe(RESULT)
    expect(record?.view).toBe('judged')
  })

  it('真实模式：请求出错（5xx、网络）也要警告，说明原因', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.reject(new ApiError(502, '网关出错'))
    expect(await outcome).toEqual({ kind: 'stale' })
    expect(bench.abandoned.value[0]?.title).toContain('可能已经写入')
    expect(bench.abandoned.value[0]?.description).toContain('网关出错')
    expect(bench.abandoned.value[0]?.result).toBeNull()
  })

  it('真实模式：写入之前就被拒绝（4xx）：什么都没发生，没有要说的', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.reject(new ApiError(404, '没有这把 Key'))
    expect(await outcome).toEqual({ kind: 'stale' })
    expect(bench.abandoned.value).toEqual([])
  })

  it('回滚模式：什么都没留下，照旧丢弃', async () => {
    const { bench, run, outcome } = await abandonRun('rollback')
    run.resolve({ ...RESULT, mode: 'rollback' })
    expect(await outcome).toEqual({ kind: 'stale' })
    expect(bench.abandoned.value).toEqual([])
  })

  it('回滚模式：请求出错也丢弃', async () => {
    const { bench, run, outcome } = await abandonRun('rollback')
    run.reject(new ApiError(500, '服务内部错误'))
    expect(await outcome).toEqual({ kind: 'stale' })
    expect(bench.abandoned.value).toEqual([])
  })

  it('没有作废：照常返回结果，不警告', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    expect(await bench.execute(STEPS, WHAT)).toEqual({ kind: 'done', result: RESULT })
    expect(bench.abandoned.value).toEqual([])
    expect(bench.abandonedInFlight.value).toBe(false)
  })

  it('请求没回来的这段时间也说一声；进行中的那次不算', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const run = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValue(run.promise)
    const outcome = bench.execute(STEPS, WHAT)
    await settle()
    expect(bench.abandonedInFlight.value).toBe(false)
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(bench.abandonedInFlight.value).toBe(true)
    run.resolve(RESULT)
    await outcome
    await settle()
    expect(bench.abandonedInFlight.value).toBe(false)
  })

  it('又开始了别的运行：作废的那次还在写入就照样说，当前的不算', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    expect(bench.abandonedInFlight.value).toBe(true)
    bench.confirmReal()
    await settle()
    expect(bench.real.value).toBe(true)
    const next = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(next.promise)
    const nextOutcome = bench.execute(STEPS, WHAT)
    await settle()
    expect(bench.running.value).toBe(true)
    expect(bench.abandonedInFlight.value).toBe(true)

    run.resolve(RESULT)
    await outcome
    await settle()
    // 只剩当前这次
    expect(bench.abandonedInFlight.value).toBe(false)
    next.resolve(RESULT)
    await nextOutcome
    expect(bench.abandonedInFlight.value).toBe(false)
  })

  it('警告不随之后的切换清掉，用户自己关；时间线里没有它', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.resolve(RESULT)
    await outcome
    const generation = bench.generation.value
    bench.confirmReal()
    await settle()
    expect(bench.generation.value).toBeGreaterThan(generation)
    expect(bench.abandoned.value).toHaveLength(1)
    expect(bench.session.value.timeline).toEqual([])
    bench.dismissAbandoned(bench.abandoned.value[0]!.id)
    expect(bench.abandoned.value).toEqual([])
  })

  it('调用台的连续调用走同一条路：作废的结果不进新的时间线，同样警告', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const run = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValue(run.promise)
    const outcome = bench.call(STEPS, 'kioku_create')
    await settle()
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    run.resolve(RESULT)
    expect(await outcome).toEqual({ kind: 'stale' })
    expect(bench.session.value.timeline).toEqual([])
    expect(bench.abandoned.value[0]?.description).toContain('「kioku_create」')
    expect(bench.abandoned.value[0]?.view).toBe('call')
  })
})

describe('切换模式', () => {
  it('切到真实每次都要确认，确认之前模式不变', async () => {
    const bench = start()
    await settle()
    bench.requestMode(true)
    expect(bench.confirmingReal.value).toBe(true)
    expect(bench.real.value).toBe(false)
    expect(bench.modeLoss.value).toBeNull()
  })

  it('真实模式下什么记录都没有：切回回滚不多问', async () => {
    const bench = await inRealMode()
    bench.requestMode(false)
    expect(bench.confirmingRollback.value).toBe(false)
    expect(bench.real.value).toBe(false)
  })

  it('真实模式下时间线有记录：切回回滚先确认，确认之前什么都不动', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call([{ kind: 'whoami' }], 'kioku_create')
    expect(bench.session.value.timeline).toHaveLength(1)
    bench.requestMode(false)
    expect(bench.confirmingRollback.value).toBe(true)
    expect(bench.real.value).toBe(true)
    await settle()
    expect(bench.session.value.timeline).toHaveLength(1)
    expect(bench.modeLoss.value).toContain('时间线（1 条）')
    expect(bench.modeLoss.value).toContain('运行标记')

    bench.confirmRollback()
    await settle()
    expect(bench.confirmingRollback.value).toBe(false)
    expect(bench.real.value).toBe(false)
    expect(bench.session.value.timeline).toEqual([])
  })

  it('确认框的正文是打开时存的：确认之后记录清掉了，关闭动画期间还在', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call(STEPS, 'kioku_create')
    bench.requestMode(false)
    const text = bench.modeLoss.value
    expect(text).toContain('时间线（1 条）')
    expect(bench.rollbackLoss.value).toBe(text)

    bench.confirmRollback()
    await settle()
    expect(bench.modeLoss.value).toBeNull()
    expect(bench.rollbackLoss.value).toBe(text)
  })

  it('取消之后再打开：正文按现在的记录说', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call(STEPS, 'kioku_create')
    bench.requestMode(false)
    bench.confirmingRollback.value = false
    await bench.call(STEPS, 'kioku_create')
    bench.requestMode(false)
    expect(bench.rollbackLoss.value).toContain('时间线（2 条）')
  })

  it('真实模式下有场景结果：一样要确认', async () => {
    const bench = await inRealMode()
    bench.scenarioOutcome.value = { title: '场景', probe: false, result: RESULT }
    bench.requestMode(false)
    expect(bench.confirmingRollback.value).toBe(true)
    expect(bench.modeLoss.value).toContain('场景结果')
  })

  it.each(['callFailure', 'scenarioFailure'] as const)(
    '真实模式下有失败的说明（%s）：一样要确认',
    async (field) => {
      const bench = await inRealMode()
      bench[field].value = '服务内部错误。可能已经执行了一部分，到活动里确认'
      bench.requestMode(false)
      expect(bench.confirmingRollback.value).toBe(true)
      expect(bench.real.value).toBe(true)
      expect(bench.modeLoss.value).toContain('运行失败的说明')
    },
  )

  it('取消：模式与记录都不动', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call([{ kind: 'whoami' }], 'kioku_create')
    bench.requestMode(false)
    bench.confirmingRollback.value = false
    await settle()
    expect(bench.real.value).toBe(true)
    expect(bench.session.value.timeline).toHaveLength(1)
  })

  it('切到真实的确认框也说场景结果：不只看时间线', async () => {
    const bench = start()
    await settle()
    bench.scenarioOutcome.value = { title: '场景', probe: false, result: RESULT }
    bench.requestMode(true)
    expect(bench.modeLoss.value).toContain('场景结果')
  })

  it('确认的时候 Key 没了：两个确认框都关掉', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call([{ kind: 'whoami' }], 'kioku_create')
    bench.requestMode(false)
    bench.confirmingReal.value = true
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(bench.confirmingRollback.value).toBe(false)
    expect(bench.confirmingReal.value).toBe(false)
    expect(bench.real.value).toBe(false)
  })
})

describe('离开页面前提醒', () => {
  const dirty = () => (fakes.guard.mock.calls[0]![0] as { value: boolean }).value
  const leavesOn = (to: object, from: object) =>
    (
      fakes.guard.mock.calls[0]![1] as {
        leavesOn: (to: object, from: object) => boolean
      }
    ).leavesOn(to, from)

  it('一开始没有要提醒的', async () => {
    start()
    await settle()
    expect(fakes.guard).toHaveBeenCalledTimes(1)
    expect(dirty()).toBe(false)
  })

  it.each(['scenario', 'drafts'] as const)('%s 改过要提醒，改回去就不用了', async (field) => {
    const bench = start()
    await settle()
    bench.unsaved[field] = true
    expect(dirty()).toBe(true)
    bench.unsaved[field] = false
    expect(dirty()).toBe(false)
  })

  it('真实模式的运行还没回来要提醒，回来了没留下记录就不用了', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    let finish!: (result: BenchRunResult) => void
    fakes.api.benchRun.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const outcome = bench.execute([{ kind: 'whoami' }], { label: '场景', view: 'judged' })
    await settle()
    expect(dirty()).toBe(true)
    finish(RESULT)
    await outcome
    expect(dirty()).toBe(false)
  })

  it('真实模式的运行出错了就不算还没回来', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    fakes.api.benchRun.mockRejectedValue(new ApiError(502, '网关出错'))
    await bench.execute([{ kind: 'whoami' }], { label: '场景', view: 'judged' })
    expect(dirty()).toBe(false)
  })

  it('真实模式下时间线有记录要提醒，清空了就不用了', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call(STEPS, 'kioku_create')
    expect(dirty()).toBe(true)
    bench.clearSession()
    expect(dirty()).toBe(false)
  })

  it('真实模式下有场景结果要提醒，没有了就不用了', async () => {
    const bench = await inRealMode()
    bench.scenarioOutcome.value = { title: '场景', probe: false, result: RESULT }
    expect(dirty()).toBe(true)
    bench.scenarioOutcome.value = null
    expect(dirty()).toBe(false)
  })

  it.each(['callFailure', 'scenarioFailure'] as const)(
    '真实模式下有失败的说明（%s）要提醒，没有了就不用了',
    async (field) => {
      const bench = await inRealMode()
      bench[field].value = '服务内部错误。可能已经执行了一部分，到活动里确认'
      expect(dirty()).toBe(true)
      bench[field].value = null
      expect(dirty()).toBe(false)
    },
  )

  it('真实模式切回回滚：确认之前都要提醒，确认之后记录清掉了就不用了', async () => {
    const bench = await inRealMode()
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.call(STEPS, 'kioku_create')
    bench.requestMode(false)
    expect(dirty()).toBe(true)
    bench.confirmRollback()
    await settle()
    expect(dirty()).toBe(false)
  })

  it('中途作废的真实运行：没回来要提醒，回来了也要，用户关掉才不用，已经不在真实模式也一样', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    expect(dirty()).toBe(true)
    run.resolve(RESULT)
    await outcome
    expect(bench.abandoned.value).toHaveLength(1)
    expect(dirty()).toBe(true)
    bench.dismissAbandoned(bench.abandoned.value[0]!.id)
    expect(dirty()).toBe(false)
  })

  it('中途作废的真实运行请求出错（5xx）：没有结果也要提醒，可能已经写入', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.reject(new ApiError(502, '网关出错'))
    await outcome
    expect(bench.abandoned.value).toHaveLength(1)
    expect(dirty()).toBe(true)
  })

  it('中途作废的真实运行写入之前就被拒绝（4xx）：什么都没留下，回来了就不用了', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    run.reject(new ApiError(404, '没有这把 Key'))
    await outcome
    expect(bench.abandoned.value).toEqual([])
    expect(dirty()).toBe(false)
  })

  it('回滚模式的结果不提醒：什么都没留下', async () => {
    const bench = start()
    await settle()
    fakes.api.benchRun.mockResolvedValue({ ...RESULT, mode: 'rollback' })
    await bench.call(STEPS, 'kioku_create')
    bench.scenarioOutcome.value = { title: '场景', probe: false, result: RESULT }
    bench.callFailure.value = '服务内部错误'
    bench.scenarioFailure.value = '服务内部错误'
    // 切换模式时这些都要说，离开时不用
    expect(bench.modeLoss.value).toContain('时间线（1 条）')
    expect(bench.modeLoss.value).toContain('场景结果')
    expect(bench.modeLoss.value).toContain('运行失败的说明')
    expect(dirty()).toBe(false)
  })

  it('回滚模式的运行不用提醒：什么都不会留下', async () => {
    const bench = start()
    await settle()
    fakes.api.benchRun.mockReturnValue(new Promise(() => {}))
    void bench.execute([{ kind: 'whoami' }], { label: '场景', view: 'judged' })
    await settle()
    expect(bench.running.value).toBe(true)
    expect(dirty()).toBe(false)
  })

  it('换应用、Key、分页只改查询参数，不算离开；写回地址也是；换空间才算', () => {
    start()
    const from = { params: { spaceId: 's1' }, query: {} }
    expect(leavesOn({ params: { spaceId: 's1' }, query: { key: 'k2' } }, from)).toBe(false)
    expect(leavesOn({ params: { spaceId: 's1' }, query: { tab: 'scenarios' } }, from)).toBe(false)
    expect(leavesOn({ params: { spaceId: 's2' }, query: {} }, from)).toBe(true)
  })
})

// 模型的一次回复
const modelReply = (content: string, calls: BenchAgentToolCall[] = []): BenchAgentTurnResult => ({
  message: {
    role: 'assistant',
    content,
    ...(calls.length
      ? {
          tool_calls: calls.map(({ id, name }) => ({
            id,
            type: 'function',
            function: { name, arguments: '{}' },
          })),
        }
      : {}),
  },
  toolCalls: calls,
  finishReason: calls.length ? 'tool_calls' : 'stop',
  usage: { promptTokens: 10, completionTokens: 2 },
  ms: 5,
  model: 'fake-model',
})
const WRITE_CALL: BenchAgentToolCall = {
  id: 'c1',
  name: 'kioku_create',
  arguments: { uri: 'core://a', content: '甲' },
  parseError: null,
}
const TOOLS_LOOP = { loop: 'tools' as const, system: '基础', model: 'fake-model' }
const CONSENT = {
  endpoint: 'https://model.example.com/v1',
  model: 'fake-model',
  loop: 'tools' as const,
}

// 模型一直不回，被取消时和真的 fetch 一样抛 AbortError。信号记下来：用例先断言它被取消了再等循环结束，
// 这样取消的逻辑坏了时是断言失败，不是等到超时
function hangingModel() {
  const model = {
    signal: undefined as AbortSignal | undefined,
    turn: (_s: string, _a: string, _k: string, _b: unknown, signal: AbortSignal) => {
      model.signal = signal
      return new Promise<BenchAgentTurnResult>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        )
      })
    },
  }
  return model
}

describe('模型对话', () => {
  const dirty = () => (fakes.guard.mock.calls[0]![0] as { value: boolean }).value

  // 走完一条消息：模型直接回复
  async function withConversation(bench: ReturnType<typeof start>) {
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('好'))
    await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(bench.agent.value.exchanges).toHaveLength(1)
  }

  it('一条消息走完：对着选中的 Key 请求模型，状态记在对话里', async () => {
    const bench = start()
    await settle()
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('好'))
    const finished = await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(1)
    const [space, appId, keyId, body, signal] = fakes.api.benchAgentTurn.mock.calls[0]!
    expect([space, appId, keyId]).toEqual(['s1', 'a1', 'k1'])
    expect(body).toMatchObject({ model: 'fake-model' })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(finished?.end).toBe('done')
    expect(bench.agent.value.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(bench.running.value).toBe(false)
    expect(bench.agentSending.value).toBe(false)
  })

  it('页面上的会话上下文带给生命周期事件', async () => {
    const bench = start()
    await settle()
    bench.contextForm.chatType = 'group'
    fakes.api.benchRun.mockImplementation(async (_s, _a, _k, request) => ({
      ...RESULT,
      mode: 'rollback',
      steps: request.steps.map((_step: unknown, index: number) => ({
        ...RESULT.steps[0]!,
        index,
        text: '',
      })),
    }))
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('好'))
    await bench.sendToAgent('你好', { ...TOOLS_LOOP, loop: 'hook' })
    const [, , , request] = fakes.api.benchRun.mock.calls[0]!
    expect(request.steps[0].body.context).toMatchObject({
      chatType: 'group',
      group: { id: 'bench-group' },
    })
  })

  it('整个循环占着运行状态：模型请求之间也不能切换，别的调用发不出去', async () => {
    const bench = start()
    await settle()
    const turn = deferred<BenchAgentTurnResult>()
    fakes.api.benchAgentTurn.mockReturnValueOnce(turn.promise)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(bench.running.value).toBe(true)
    expect(bench.agentSending.value).toBe(true)
    // 调用台与场景都走 execute
    expect(await bench.execute(STEPS, WHAT)).toEqual({ kind: 'stale' })
    expect(fakes.api.benchRun).not.toHaveBeenCalled()
    // 同时只能有一条消息
    expect(await bench.sendToAgent('又一句', TOOLS_LOOP)).toBeNull()
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(1)
    // 运行期间不能改对话
    bench.clearAgent()
    bench.consentTo(CONSENT)
    expect(bench.agent.value.exchanges).toHaveLength(1)
    expect(bench.agent.value.consented).toBeNull()
    turn.resolve(modelReply('好'))
    await sent
    expect(bench.running.value).toBe(false)
  })

  it('调用台在运行时发不了消息，但同意的提示点得了：两边不相干', async () => {
    const bench = start()
    await settle()
    const run = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(run.promise)
    const outcome = bench.execute(STEPS, WHAT)
    await settle()
    expect(await bench.sendToAgent('你好', TOOLS_LOOP)).toBeNull()
    expect(fakes.api.benchAgentTurn).not.toHaveBeenCalled()
    bench.consentTo(CONSENT)
    expect(bench.agent.value.consented).toEqual(CONSENT)
    run.resolve({ ...RESULT, mode: 'rollback' })
    await outcome
  })

  it('谁在运行：模型循环占着时调用台与场景都不算自己在跑，按钮不转圈；能从那边停止', async () => {
    const bench = start()
    await settle()
    const model = hangingModel()
    fakes.api.benchAgentTurn.mockImplementationOnce(model.turn)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(bench.running.value).toBe(true)
    expect(bench.agentSending.value).toBe(true)
    expect(bench.callRunning.value).toBe(false)
    expect(bench.scenarioRunning.value).toBe(false)
    bench.stopAgent()
    expect(model.signal?.aborted).toBe(true)
    await sent
    expect(bench.running.value).toBe(false)
    expect(bench.agentSending.value).toBe(false)
  })

  it('谁在运行：调用台的只算调用台，场景的只算场景，都不算模型对话', async () => {
    const bench = start()
    await settle()
    const calling = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(calling.promise)
    const called = bench.call(STEPS, 'kioku_list')
    await settle()
    expect(bench.callRunning.value).toBe(true)
    expect(bench.scenarioRunning.value).toBe(false)
    expect(bench.agentSending.value).toBe(false)
    calling.resolve({ ...RESULT, mode: 'rollback' })
    await called
    expect(bench.callRunning.value).toBe(false)

    const scenario = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(scenario.promise)
    const ran = bench.execute(STEPS, WHAT)
    await settle()
    expect(bench.scenarioRunning.value).toBe(true)
    expect(bench.callRunning.value).toBe(false)
    expect(bench.agentSending.value).toBe(false)
    scenario.resolve({ ...RESULT, mode: 'rollback' })
    await ran
    expect(bench.scenarioRunning.value).toBe(false)
  })

  it('谁在运行：上一次是调用台，这次是模型循环，不留着上一次的；中途作废就不算在跑了', async () => {
    const bench = start()
    await settle()
    fakes.api.benchRun.mockResolvedValueOnce({ ...RESULT, mode: 'rollback' })
    await bench.call(STEPS, 'kioku_list')
    const model = hangingModel()
    fakes.api.benchAgentTurn.mockImplementationOnce(model.turn)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(bench.callRunning.value).toBe(false)
    bench.stopAgent()
    await sent

    const run = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(run.promise)
    const called = bench.call(STEPS, 'kioku_list')
    await settle()
    expect(bench.callRunning.value).toBe(true)
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    // 作废了：请求还没回来，按钮不能还转着
    expect(bench.callRunning.value).toBe(false)
    run.resolve({ ...RESULT, mode: 'rollback' })
    await called
  })

  it('工具走运行接口，带这次对话的重放，不带调用台的', async () => {
    const bench = start()
    await settle()
    fakes.api.benchRun.mockResolvedValueOnce({
      ...RESULT,
      mode: 'rollback',
      steps: [
        {
          ...RESULT.steps[0]!,
          replay: { kind: 'tool', tool: 'kioku_create', arguments: { uri: 'core://call' } },
        },
      ],
    })
    await bench.call(STEPS, 'kioku_create')
    expect(bench.session.value.replay).toHaveLength(1)

    fakes.api.benchRun.mockResolvedValue({
      ...RESULT,
      mode: 'rollback',
      steps: [
        {
          ...RESULT.steps[0]!,
          replay: { kind: 'tool', tool: 'kioku_create', arguments: WRITE_CALL.arguments },
        },
      ],
    })
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockResolvedValueOnce(modelReply('', [{ ...WRITE_CALL, id: 'c2' }]))
      .mockResolvedValueOnce(modelReply('好'))
    await bench.sendToAgent('你好', TOOLS_LOOP)
    const replays = fakes.api.benchRun.mock.calls.map(([, , , request]) => request.replay)
    expect(replays[1]).toEqual([])
    expect(replays[2]).toEqual([
      { kind: 'tool', tool: 'kioku_create', arguments: WRITE_CALL.arguments },
    ])
    // 两边的日志互不相干
    expect(bench.session.value.replay).toHaveLength(1)
    expect(bench.agent.value.session.replay).toHaveLength(2)
  })

  it('停止：正在等的模型请求被取消，不再发新的请求', async () => {
    const bench = start()
    await settle()
    const model = hangingModel()
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockImplementationOnce(model.turn)
    fakes.api.benchRun.mockResolvedValue({ ...RESULT, mode: 'rollback' })
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(2)
    bench.stopAgent()
    expect(bench.agentStopping.value).toBe(true)
    expect(model.signal?.aborted).toBe(true)
    const finished = await sent
    expect(finished?.end).toBe('stopped')
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(2)
    expect(bench.running.value).toBe(false)
    expect(bench.agentStopping.value).toBe(false)
    expect(bench.agent.value.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('没有在发消息时停止：什么都不做', async () => {
    const bench = start()
    await settle()
    bench.stopAgent()
    expect(bench.agentStopping.value).toBe(false)
  })

  it('离开页面：模型请求一起取消，不继续花 token', async () => {
    const bench = start()
    await settle()
    const model = hangingModel()
    fakes.api.benchAgentTurn.mockImplementationOnce(model.turn)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(model.signal?.aborted).toBe(false)
    scope.stop()
    expect(model.signal?.aborted).toBe(true)
    await sent
  })

  it('运行中 Key 没了：对话清掉，请求取消，回到回滚；旧的循环写不回新的对话，也不再发请求', async () => {
    const bench = start()
    await settle()
    const generation = bench.generation.value
    const model = hangingModel()
    fakes.api.benchAgentTurn.mockImplementationOnce(model.turn)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(bench.agent.value.exchanges).toHaveLength(1)

    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(bench.generation.value).toBeGreaterThan(generation)
    expect(model.signal?.aborted).toBe(true)
    expect(bench.running.value).toBe(false)
    expect(await sent).toBeNull()
    expect(bench.agent.value.exchanges).toEqual([])
    expect(bench.agent.value.messages).toEqual([])
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(1)
  })

  it('换 Key 之后接着发：是新的一段对话，对着新的 Key', async () => {
    const bench = start()
    await settle()
    await withConversation(bench)
    bench.selectKey('k2')
    await settle()
    expect(bench.agent.value.exchanges).toEqual([])
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('好'))
    await bench.sendToAgent('新的', TOOLS_LOOP)
    const [, , keyId, body] = fakes.api.benchAgentTurn.mock.calls.at(-1)!
    expect(keyId).toBe('k2')
    expect(body.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1)
  })

  it('换应用、换模式都清掉对话', async () => {
    const bench = start()
    await settle()
    await withConversation(bench)
    bench.selectApp('a2')
    await settle()
    expect(bench.agent.value.exchanges).toEqual([])
    await withConversation(bench)
    bench.confirmReal()
    await settle()
    expect(bench.agent.value.exchanges).toEqual([])
  })

  it('接受重放分叉：对话的日志去掉那一步，分叉清掉；调用台的会话不动；运行期间不能接受', async () => {
    const bench = start()
    await settle()
    const replay = { kind: 'tool', tool: 'kioku_create', arguments: WRITE_CALL.arguments }
    fakes.api.benchRun.mockResolvedValueOnce({
      ...RESULT,
      mode: 'rollback',
      steps: [{ ...RESULT.steps[0]!, replay }],
    })
    await bench.call(STEPS, 'kioku_create')
    fakes.api.benchRun
      .mockResolvedValueOnce({
        ...RESULT,
        mode: 'rollback',
        steps: [{ ...RESULT.steps[0]!, replay }],
      })
      .mockResolvedValueOnce({
        ...RESULT,
        mode: 'rollback',
        ok: false,
        replayDiverged: { index: 0, text: 'URI 已存在', internalError: false },
      })
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockResolvedValueOnce(modelReply('', [{ ...WRITE_CALL, id: 'c2', name: 'kioku_list' }]))
    await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(bench.agent.value.session.diverged?.index).toBe(0)
    expect(bench.agent.value.session.replay).toHaveLength(1)

    bench.acceptAgentDiverged()
    expect(bench.agent.value.session.diverged).toBeNull()
    expect(bench.agent.value.session.replay).toEqual([])
    expect(bench.session.value.replay).toHaveLength(1)

    // 运行期间不动：结果回来时第几步是按发出请求时的日志算的
    bench.agent.value = {
      ...bench.agent.value,
      session: {
        ...bench.agent.value.session,
        diverged: { index: 0, text: '又报错', internalError: false },
      },
    }
    const run = deferred<BenchRunResult>()
    fakes.api.benchRun.mockReturnValueOnce(run.promise)
    const outcome = bench.execute(STEPS, WHAT)
    await settle()
    expect(bench.running.value).toBe(true)
    bench.acceptAgentDiverged()
    expect(bench.agent.value.session.diverged).not.toBeNull()
    run.resolve({ ...RESULT, mode: 'rollback' })
    await outcome
  })

  it('同意过的随对话清掉：换一段对话要重新问', async () => {
    const bench = start()
    await settle()
    bench.consentTo(CONSENT)
    expect(bench.agent.value.consented).toEqual(CONSENT)
    bench.selectKey('k2')
    await settle()
    expect(bench.agent.value.consented).toBeNull()
    bench.consentTo(CONSENT)
    bench.clearAgent()
    expect(bench.agent.value.consented).toBeNull()
  })

  it('真实模式的工具运行中途作废：警告可能已经写入，带上这次运行是什么，结果按调用的看法显示', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const run = deferred<BenchRunResult>()
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
    fakes.api.benchRun.mockReturnValueOnce(run.promise)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(bench.abandonedInFlight.value).toBe(false)
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(bench.real.value).toBe(false)
    expect(bench.abandonedInFlight.value).toBe(true)
    run.resolve(RESULT)
    expect(await sent).toBeNull()
    await settle()
    expect(bench.abandonedInFlight.value).toBe(false)
    const [record] = bench.abandoned.value
    expect(record?.title).toContain('可能已经写入')
    expect(record?.description).toContain('kioku_create')
    expect(record?.description).toContain('「应用a1」的 Key「Keyk1」')
    expect(record?.view).toBe('call')
    expect(record?.result).toBe(RESULT)
    // 不再请求模型：对话已经作废
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(1)
    expect(bench.agent.value.exchanges).toEqual([])
  })

  it('作废的运行还在写入时又发一条消息：等模型时没有运行在途，不能把它抵消掉；工具运行在途时也不算当前这次', async () => {
    const { bench, run, outcome } = await abandonRun('real')
    expect(bench.abandonedInFlight.value).toBe(true)
    bench.confirmReal()
    await settle()
    expect(bench.real.value).toBe(true)

    const model = deferred<BenchAgentTurnResult>()
    const tool = deferred<BenchRunResult>()
    fakes.api.benchAgentTurn
      .mockReturnValueOnce(model.promise)
      .mockResolvedValueOnce(modelReply('好'))
    fakes.api.benchRun.mockReturnValueOnce(tool.promise)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    // 等模型：运行占着，作废的那次还在写入
    expect(bench.running.value).toBe(true)
    expect(bench.real.value).toBe(true)
    expect(bench.abandonedInFlight.value).toBe(true)

    // 工具运行也在途：两个请求，有一个是作废的
    model.resolve(modelReply('', [WRITE_CALL]))
    await settle()
    expect(fakes.api.benchRun).toHaveBeenCalledTimes(2)
    expect(bench.abandonedInFlight.value).toBe(true)

    // 作废的回来了，只剩这条消息自己的运行
    run.resolve(RESULT)
    await outcome
    await settle()
    expect(bench.running.value).toBe(true)
    expect(bench.abandonedInFlight.value).toBe(false)

    tool.resolve(RESULT)
    await sent
    expect(bench.abandonedInFlight.value).toBe(false)
  })

  it('真实模式下工具已经跑完、等模型时作废：对话清掉了，写入还是要说，运行标记留着', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const model = hangingModel()
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockImplementationOnce(model.turn)
    fakes.api.benchRun.mockResolvedValueOnce(RESULT)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(2)
    expect(bench.abandoned.value).toEqual([])
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(model.signal?.aborted).toBe(true)
    expect(await sent).toBeNull()
    expect(bench.agent.value.exchanges).toEqual([])
    const [record] = bench.abandoned.value
    expect(bench.abandoned.value).toHaveLength(1)
    expect(record?.title).toContain('可能已经写入')
    expect(record?.description).toContain('kioku_create')
    expect(record?.description).toContain('「应用a1」的 Key「Keyk1」')
    expect(record?.view).toBe('call')
    expect(record?.result?.run).toBe(RESULT.run)
    // 能一条一条关
    bench.dismissAbandoned(record!.id)
    expect(bench.abandoned.value).toEqual([])
  })

  it('真实模式下读工具跑完才作废：没有写，不说', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const read = { ...WRITE_CALL, name: 'kioku_list', arguments: {} }
    const model = hangingModel()
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [read]))
      .mockImplementationOnce(model.turn)
    fakes.api.benchRun.mockResolvedValueOnce(RESULT)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(model.signal?.aborted).toBe(true)
    await sent
    expect(bench.abandoned.value).toEqual([])
  })

  it('没有作废的循环：写过也不警告', async () => {
    const bench = await inRealMode()
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockResolvedValueOnce(modelReply('好'))
    fakes.api.benchRun.mockResolvedValueOnce(RESULT)
    const finished = await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(finished?.end).toBe('done')
    expect(bench.abandoned.value).toEqual([])
  })

  it('回滚模式下工具跑完、等模型时作废：什么都没留下，不警告', async () => {
    const bench = start()
    await settle()
    const model = hangingModel()
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockImplementationOnce(model.turn)
    fakes.api.benchRun.mockResolvedValueOnce({ ...RESULT, mode: 'rollback' })
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    expect(model.signal?.aborted).toBe(true)
    await sent
    expect(bench.abandoned.value).toEqual([])
  })

  it('回滚模式的运行中途作废：什么都没留下，不警告', async () => {
    const bench = start()
    await settle()
    const run = deferred<BenchRunResult>()
    fakes.api.benchAgentTurn.mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
    fakes.api.benchRun.mockReturnValueOnce(run.promise)
    const sent = bench.sendToAgent('你好', TOOLS_LOOP)
    await settle()
    fakes.api.keys.mockResolvedValue([liveKey('k2')])
    await refetchKeys()
    run.resolve({ ...RESULT, mode: 'rollback' })
    expect(await sent).toBeNull()
    expect(bench.abandoned.value).toEqual([])
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(1)
  })

  it('真实模式：一轮里新建被拒，删除没有发到运行接口，中间的读操作照发', async () => {
    const bench = await inRealMode()
    const broken = { id: 'new', name: 'kioku_create', arguments: null, parseError: '坏了' }
    const read = {
      id: 'get',
      name: 'kioku_get',
      arguments: { uri: 'core://old' },
      parseError: null,
    }
    const remove = {
      id: 'del',
      name: 'kioku_delete',
      arguments: { uri: 'core://old' },
      parseError: null,
    }
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [broken, read, remove]))
      .mockResolvedValueOnce(modelReply('好'))
    fakes.api.benchRun.mockResolvedValueOnce(RESULT)
    const finished = await bench.sendToAgent('换一条', TOOLS_LOOP)
    expect(finished?.end).toBe('done')
    expect(fakes.api.benchRun).toHaveBeenCalledTimes(1)
    const [, , , request] = fakes.api.benchRun.mock.calls[0]!
    expect(request.mode).toBe('real')
    expect(request.steps).toEqual([
      { kind: 'tool', tool: 'kioku_get', arguments: { uri: 'core://old' } },
    ])
    // 只读的运行：清空对话不用确认
    expect(bench.agent.value.mayHaveWritten).toBe(false)
  })

  it('真实模式：一轮里只有被拒的新建和删除：运行接口一次都没有请求', async () => {
    const bench = await inRealMode()
    const broken = { id: 'new', name: 'kioku_create', arguments: null, parseError: '坏了' }
    const remove = {
      id: 'del',
      name: 'kioku_delete',
      arguments: { uri: 'core://old' },
      parseError: null,
    }
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [broken, remove]))
      .mockResolvedValueOnce(modelReply('好'))
    await bench.sendToAgent('换一条', TOOLS_LOOP)
    expect(fakes.api.benchRun).not.toHaveBeenCalled()
    expect(fakes.api.benchAgentTurn).toHaveBeenCalledTimes(2)
  })

  it('真实模式下工具写了数据：缓存重新读，运行标记记在轨迹上', async () => {
    const bench = start()
    await settle()
    bench.confirmReal()
    await settle()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fakes.api.benchAgentTurn
      .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
      .mockResolvedValueOnce(modelReply('好'))
    fakes.api.benchRun.mockResolvedValue(RESULT)
    await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(invalidate).toHaveBeenCalledWith()
    expect(bench.agent.value.exchanges[0]?.rounds[0]?.calls[0]?.trace?.run).toBe(RESULT.run)
  })

  it.each([
    [403, true],
    [404, true],
    [400, false],
  ])('请求模型 %i：Key 被吊销时选择跟上，模型的情况重新读', async (status, refetchKeysToo) => {
    const bench = start()
    await settle()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fakes.api.benchAgentTurn.mockRejectedValueOnce(new ApiError(status, '拒绝'))
    const finished = await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(finished?.end).toBe('modelFailed')
    expect(finished?.notice).toContain('拒绝')
    const invalidated = invalidate.mock.calls.map(
      ([filters]) => (filters as { queryKey?: unknown[] } | undefined)?.queryKey?.[0],
    )
    expect(invalidated).toContain('bench-agent')
    expect(invalidated.includes('keys')).toBe(refetchKeysToo)
  })

  describe('生命周期事件的运行请求失败', () => {
    const HOOK_LOOP = { ...TOOLS_LOOP, loop: 'hook' as const }

    it.each([
      [400, '请求不合法'],
      [403, '没有权限'],
      [404, '没有这把 Key'],
    ])('HTTP %i：确定性的拒绝，只显示原因', async (status, message) => {
      const bench = start()
      await settle()
      fakes.api.benchRun.mockRejectedValueOnce(new ApiError(status, message))
      const finished = await bench.sendToAgent('你好', HOOK_LOOP)
      expect(finished?.end).toBe('lifecycleFailed')
      expect(finished?.notice).toBe(message)
      expect(fakes.api.benchAgentTurn).not.toHaveBeenCalled()
    })

    it.each([
      ['HTTP 500', new ApiError(500, '服务内部错误'), '服务内部错误'],
      ['HTTP 429', new ApiError(429, '同时运行的回滚太多'), '同时运行的回滚太多'],
      ['网络错误', new TypeError('Failed to fetch'), '网络出错了'],
    ] as [string, Error, string][])(
      '%s：可能是暂时的，说可以再发一次',
      async (_name, err, text) => {
        const bench = start()
        await settle()
        fakes.api.benchRun.mockRejectedValueOnce(err)
        const finished = await bench.sendToAgent('你好', HOOK_LOOP)
        expect(finished?.notice).toContain(text)
        expect(finished?.notice).toContain('没有请求模型，可以再发一次')
      },
    )
  })

  it('运行的结果带上再发一次有没有用', async () => {
    const bench = start()
    await settle()
    fakes.api.benchRun.mockRejectedValueOnce(new ApiError(403, '没有权限'))
    expect(await bench.execute(STEPS, WHAT)).toEqual({
      kind: 'failed',
      message: '没有权限',
      retryable: false,
    })
    fakes.api.benchRun.mockRejectedValueOnce(new ApiError(502, '网关出错'))
    expect(await bench.execute(STEPS, WHAT)).toEqual({
      kind: 'failed',
      message: '网关出错',
      retryable: true,
    })
  })

  it('请求模型 502：是上游的问题，不重新读', async () => {
    const bench = start()
    await settle()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    fakes.api.benchAgentTurn.mockRejectedValueOnce(new ApiError(502, '上游挂了'))
    await bench.sendToAgent('你好', TOOLS_LOOP)
    expect(invalidate).not.toHaveBeenCalled()
  })

  describe('离开提醒', () => {
    it('对话有内容时要提醒，回滚模式也算；清空就不用了', async () => {
      const bench = start()
      await settle()
      expect(dirty()).toBe(false)
      await withConversation(bench)
      expect(bench.real.value).toBe(false)
      expect(dirty()).toBe(true)
      bench.clearAgent()
      expect(dirty()).toBe(false)
    })

    it('只点过同意、还没说话：没有要丢的', async () => {
      const bench = start()
      await settle()
      bench.consentTo(CONSENT)
      expect(dirty()).toBe(false)
    })

    it('换了 Key 对话清掉了，就不用提醒', async () => {
      const bench = start()
      await settle()
      await withConversation(bench)
      bench.selectKey('k2')
      await settle()
      expect(dirty()).toBe(false)
    })

    it('发出去还没回来时就算有内容', async () => {
      const bench = start()
      await settle()
      const model = hangingModel()
      fakes.api.benchAgentTurn.mockImplementationOnce(model.turn)
      const sent = bench.sendToAgent('你好', TOOLS_LOOP)
      await settle()
      expect(dirty()).toBe(true)
      bench.stopAgent()
      expect(model.signal?.aborted).toBe(true)
      await sent
    })
  })

  describe('切换模式', () => {
    it('真实模式下有对话：切回回滚先确认，说对话会清掉；确认之前什么都不动', async () => {
      const bench = await inRealMode()
      await withConversation(bench)
      bench.requestMode(false)
      expect(bench.confirmingRollback.value).toBe(true)
      expect(bench.real.value).toBe(true)
      expect(bench.rollbackLoss.value).toContain('模型对话（1 条消息）')
      expect(bench.rollbackLoss.value).toContain('运行标记')
      await settle()
      expect(bench.agent.value.exchanges).toHaveLength(1)

      bench.confirmRollback()
      await settle()
      expect(bench.real.value).toBe(false)
      expect(bench.agent.value.exchanges).toEqual([])
      expect(bench.modeLoss.value).toBeNull()
      // 正文是打开时存的：关闭动画期间还在
      expect(bench.rollbackLoss.value).toContain('模型对话')
    })

    it('回滚模式下有对话：切到真实的确认框也说对话会清掉，保留的写入不带过去', async () => {
      const bench = start()
      await settle()
      fakes.api.benchRun.mockResolvedValue({
        ...RESULT,
        mode: 'rollback',
        steps: [
          {
            ...RESULT.steps[0]!,
            replay: { kind: 'tool', tool: 'kioku_create', arguments: WRITE_CALL.arguments },
          },
        ],
      })
      fakes.api.benchAgentTurn
        .mockResolvedValueOnce(modelReply('', [WRITE_CALL]))
        .mockResolvedValueOnce(modelReply('好'))
      await bench.sendToAgent('你好', TOOLS_LOOP)
      bench.requestMode(true)
      expect(bench.confirmingReal.value).toBe(true)
      expect(bench.modeLoss.value).toContain('模型对话（1 条消息）')
      expect(bench.modeLoss.value).toContain('保留的写入不会带过去')
    })

    it('真实模式下对话清空了：切回回滚不多问', async () => {
      const bench = await inRealMode()
      await withConversation(bench)
      bench.clearAgent()
      bench.requestMode(false)
      expect(bench.confirmingRollback.value).toBe(false)
      expect(bench.real.value).toBe(false)
    })
  })
})
