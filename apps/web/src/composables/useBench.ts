import type { BenchMode, BenchReplayStep, BenchRunResult, BenchStep } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, inject, provide, reactive, ref, watch, type InjectionKey } from 'vue'
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { contextDefaults, contextOf } from '../benchForm'
import { ownedApps, runFailureMessage, usableKeys } from '../benchSession'
import { useSession } from './useSession'

const param = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

// 地址里的选择。只在测试台页面上读：离开时路由先变、组件后卸载，这段时间不跟着路由走
const selectionOf = (route: RouteLocationNormalizedLoaded) => ({
  spaceId: String(route.params.spaceId),
  app: param(route.query.app),
  key: param(route.query.key),
})

// 一次运行的结果。stale：运行期间换了应用、Key 或模式，结果作废；或者上一次还没结束，这次没有发出去
export type RunOutcome =
  { kind: 'done'; result: BenchRunResult } | { kind: 'failed'; message: string } | { kind: 'stale' }

// 测试台各分页共享的状态：应用、Key、模式、会话上下文。页面建一份，分页组件用 useBench 取同一份
function createBench() {
  const route = useRoute()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { me } = useSession()

  const selection = reactive(selectionOf(route))
  watch(
    () => route.fullPath,
    () => {
      if (route.name === 'bench') Object.assign(selection, selectionOf(route))
    },
  )
  const spaceId = computed(() => selection.spaceId)

  const apps = useQuery({
    queryKey: computed(() => ['apps', selection.spaceId]),
    queryFn: () => api.apps(selection.spaceId),
  })
  const owned = computed(() => ownedApps(apps.data.value ?? [], me.data.value?.id))
  const appId = computed(() => {
    const list = owned.value
    return list.find((a) => a.id === selection.app)?.id ?? list[0]?.id
  })
  const app = computed(() => owned.value.find((a) => a.id === appId.value) ?? null)

  const keys = useQuery({
    queryKey: computed(() => ['keys', selection.spaceId, appId.value]),
    queryFn: () => api.keys(selection.spaceId, appId.value!),
    enabled: computed(() => Boolean(appId.value)),
  })
  const usable = computed(() => usableKeys(keys.data.value ?? []))
  const keyId = computed(() => {
    const list = usable.value
    return list.find((k) => k.id === selection.key)?.id ?? list[0]?.id
  })
  const key = computed(() => usable.value.find((k) => k.id === keyId.value) ?? null)
  const ready = computed(() => Boolean(app.value && key.value))

  // 选择记在地址里：刷新、分享都还在。模式不记：真实模式每次都要确认
  const select = (query: { app?: string; key?: string }) =>
    void router.replace({ query: { ...route.query, ...query } })
  const selectApp = (id: string) => select({ app: id, key: undefined })
  const selectKey = (id: string) => select({ key: id })

  // 地址里的应用或 Key 用不了（链接是别人的、Key 刚被吊销）时说一声，不悄悄换
  const selectionNotice = computed(() => {
    if (apps.data.value && selection.app && app.value?.id !== selection.app) {
      return '链接里的应用不是你的，或者已经删掉了：只有应用主人能用测试台。这里换成了你自己的应用。'
    }
    if (keys.data.value && selection.key && key.value?.id !== selection.key) {
      return '选中的 Key 已经失效或不属于这个应用：这里换成了它别的有效 Key。'
    }
    return null
  })

  const mode = ref<BenchMode>('rollback')
  const real = computed(() => mode.value === 'real')
  const confirmingReal = ref(false)
  // 切到真实要确认，切回回滚不用
  function requestMode(wantReal: boolean) {
    if (wantReal) confirmingReal.value = true
    else mode.value = 'rollback'
  }
  function confirmReal() {
    confirmingReal.value = false
    mode.value = 'real'
  }
  // 换了应用或 Key 就回到回滚：真实模式是对着这把 Key 确认的
  watch([spaceId, appId, keyId], () => {
    mode.value = 'rollback'
    confirmingReal.value = false
  })

  const contextForm = reactive(contextDefaults())
  const sessionContext = computed(() => contextOf(contextForm))

  // 每次运行一个序号，current 是进行中的那次：结果、报错与 loading 都只认它。
  // 换了应用、Key 或模式时清掉，进行中的那次就作废了；generation 让各分页清掉自己的结果
  let counter = 0
  const current = ref<number | null>(null)
  const running = computed(() => current.value !== null)
  const generation = ref(0)
  watch([spaceId, appId, keyId, mode], () => {
    current.value = null
    generation.value++
  })

  async function execute(steps: BenchStep[], replay: BenchReplayStep[] = []): Promise<RunOutcome> {
    const forSpace = spaceId.value
    const forApp = appId.value
    const forKey = keyId.value
    const forMode = mode.value
    if (running.value || !forApp || !forKey) return { kind: 'stale' }
    const id = ++counter
    current.value = id
    try {
      const result = await api.benchRun(forSpace, forApp, forKey, { mode: forMode, steps, replay })
      return current.value === id ? { kind: 'done', result } : { kind: 'stale' }
    } catch (err) {
      // 应用转给了别人、Key 刚被吊销：重新读一遍，选择跟着变
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: ['apps', forSpace] })
        void queryClient.invalidateQueries({ queryKey: ['keys', forSpace, forApp] })
      }
      return current.value === id
        ? { kind: 'failed', message: runFailureMessage(err, forMode) }
        : { kind: 'stale' }
    } finally {
      if (current.value === id) current.value = null
      // 真实模式写了数据（出错也可能写了一部分）：记忆、活动、对象、凭据的缓存都不算数了
      if (forMode === 'real') void queryClient.invalidateQueries()
    }
  }

  return {
    spaceId,
    apps,
    owned,
    appId,
    app,
    keys,
    usable,
    keyId,
    key,
    ready,
    selectApp,
    selectKey,
    selectionNotice,
    mode,
    real,
    confirmingReal,
    requestMode,
    confirmReal,
    contextForm,
    sessionContext,
    running,
    generation,
    execute,
  }
}

export type Bench = ReturnType<typeof createBench>
const BENCH: InjectionKey<Bench> = Symbol('bench')

export function provideBench(): Bench {
  const bench = createBench()
  provide(BENCH, bench)
  return bench
}

export function useBench(): Bench {
  const bench = inject(BENCH)
  if (!bench) throw new Error('useBench 只能用在测试台页面里')
  return bench
}
