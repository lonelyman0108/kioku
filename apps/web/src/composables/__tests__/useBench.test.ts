import type { AppInfo, KeyInfo, KeyScopes } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createApp, effectScope, nextTick, reactive, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
}))

vi.mock('vue-router', () => ({
  useRoute: () => fakes.route,
  useRouter: () => fakes.router,
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))
vi.mock('../useSession', () => ({ useSession: () => ({ me: { data: ref({ id: 'me' }) } }) }))

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

// 地址：query 里 undefined 的项和真的 vue-router 一样去掉。导航和真的一样是异步的
function fakeRouter(query: Record<string, string>, name = 'bench') {
  const fullPath = (q: Record<string, string>) => `/spaces/s1/bench?${new URLSearchParams(q)}`
  const route = reactive({ name, params: { spaceId: 's1' }, query, fullPath: fullPath(query) })
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

function start(query: Record<string, string> = {}, name = 'bench') {
  fake = fakeRouter(query, name)
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

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fakes.api.apps.mockReset().mockResolvedValue([app('a1'), app('a2')])
  fakes.api.keys.mockReset().mockResolvedValue([liveKey('k1'), liveKey('k2')])
  fakes.api.benchRun.mockReset()
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
    const writes: unknown[] = []
    fake.router.replace.mockClear()
    bench.selectApp('a2')
    await settle()
    for (const [to] of fake.router.replace.mock.calls) writes.push(to.query.key)
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
