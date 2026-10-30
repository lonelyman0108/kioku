import type { AppInfo, BenchRunResult, KeyInfo, KeyScopes, WhoAmI } from '@kioku/contracts'
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
