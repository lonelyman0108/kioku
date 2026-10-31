import type { InboxCounts } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, reactive, ref, type EffectScope } from 'vue'

import { useInboxCounts } from '../useInboxCounts'
import { useInboxTab } from '../useInboxTab'

// 路由和接口换成假的，vue-query 是真的：要看的是查询、地址和分类配在一起时的时序
const fakes = vi.hoisted(() => ({
  route: null as unknown,
  router: null as unknown,
  api: { inboxCounts: vi.fn() },
}))
vi.mock('vue-router', () => ({
  useRoute: () => fakes.route,
  useRouter: () => fakes.router,
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const counts = (over: Partial<InboxCounts> = {}): InboxCounts => {
  const merged = { bindings: 0, review: 0, dreamSuggestions: 0, plaintext: 0, ...over }
  return {
    ...merged,
    total: merged.bindings + merged.review + merged.dreamSuggestions + merged.plaintext,
  }
}

let client: QueryClient
let scope: EffectScope
let route: { name: string; query: Record<string, string> }
let replace: ReturnType<typeof vi.fn>
const spaceId = ref('s1')

function start(query: Record<string, string> = {}) {
  route = reactive({ name: 'inbox', query })
  replace = vi.fn(async (to: { query: Record<string, string> }) => {
    await Promise.resolve()
    route.query = to.query
  })
  fakes.route = route
  fakes.router = { replace }
  const vueApp = createApp({})
  vueApp.use(VueQueryPlugin, { queryClient: client })
  scope = effectScope()
  return vueApp.runWithContext(() => scope.run(() => useInboxTab(useInboxCounts(spaceId)))!)
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
  }
}

const setCounts = async (value: InboxCounts) => {
  fakes.api.inboxCounts.mockResolvedValue(value)
  await client.invalidateQueries({ queryKey: ['inbox-counts'] })
  await settle()
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  spaceId.value = 's1'
  fakes.api.inboxCounts.mockReset()
})
afterEach(() => {
  scope.stop()
  client.clear()
})

describe('地址没带分类', () => {
  it('条数读到之前不决定，不动地址', async () => {
    fakes.api.inboxCounts.mockReturnValue(new Promise(() => {}))
    const tab = start()
    await settle()
    expect(tab.value).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })

  it('读到之后定下来，写回地址，别的参数留着', async () => {
    fakes.api.inboxCounts.mockResolvedValue(counts({ review: 2, plaintext: 1 }))
    const tab = start({ other: 'x' })
    await settle()
    expect(tab.value).toBe('review')
    expect(replace).toHaveBeenCalledTimes(1)
    expect(route.query).toEqual({ other: 'x', tab: 'review' })
  })

  it('定下来之后条数怎么变都不跳：确认完最后一条绑定不走，来了新绑定也不走', async () => {
    fakes.api.inboxCounts.mockResolvedValue(counts({ bindings: 1, review: 3 }))
    const tab = start()
    await settle()
    expect(tab.value).toBe('binding')
    await setCounts(counts({ review: 3 }))
    expect(tab.value).toBe('binding')
    expect(route.query.tab).toBe('binding')

    fakes.api.inboxCounts.mockResolvedValue(counts({ review: 3 }))
    client.clear()
    scope.stop()
    const second = start()
    await settle()
    expect(second.value).toBe('review')
    await setCounts(counts({ bindings: 1, review: 3 }))
    expect(second.value).toBe('review')
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('读取失败时也定下来，不一直等', async () => {
    fakes.api.inboxCounts.mockRejectedValue(new Error('读不到'))
    const tab = start()
    await settle()
    expect(tab.value).toBe('review')
    expect(route.query.tab).toBe('review')
  })

  it('换空间时不把上一个空间的分类写进地址', async () => {
    fakes.api.inboxCounts.mockImplementation(async (id: string) =>
      id === 's1' ? counts({ bindings: 1 }) : counts({ plaintext: 1 }),
    )
    const tab = start()
    await settle()
    expect(route.query.tab).toBe('binding')
    // 换空间的导航不带分类
    spaceId.value = 's2'
    route.query = {}
    await settle()
    expect(tab.value).toBe('plaintext')
    expect(replace.mock.calls.map(([to]) => to.query.tab)).toEqual(['binding', 'plaintext'])
  })
})

describe('地址带了分类', () => {
  it('就看那一类，不动地址，哪怕是空的', async () => {
    fakes.api.inboxCounts.mockResolvedValue(counts({ review: 2 }))
    const tab = start({ tab: 'dream' })
    await settle()
    expect(tab.value).toBe('dream')
    expect(replace).not.toHaveBeenCalled()
  })

  it('写错了按没写算，写回正确的', async () => {
    fakes.api.inboxCounts.mockResolvedValue(counts({ plaintext: 2 }))
    const tab = start({ tab: 'nope' })
    await settle()
    expect(tab.value).toBe('plaintext')
    expect(route.query.tab).toBe('plaintext')
  })

  it('已经离开待处理页时不写地址', async () => {
    fakes.api.inboxCounts.mockReturnValue(new Promise(() => {}))
    start()
    await settle()
    route.name = 'memories'
    client.setQueryData(['inbox-counts', 's1'], counts({ review: 1 }))
    await settle()
    expect(replace).not.toHaveBeenCalled()
  })
})
