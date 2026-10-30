import type { BenchMode, BenchReplayStep, BenchRunResult, BenchStep } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  computed,
  inject,
  provide,
  reactive,
  ref,
  shallowRef,
  watch,
  watchPostEffect,
  type InjectionKey,
  type Ref,
} from 'vue'
import { useRoute, useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { contextDefaults, contextOf } from '../benchForm'
import type { StepView } from '../benchResult'
import {
  abandonedRun,
  acceptDivergence,
  emptySession,
  ownedApps,
  recordRun,
  replayFor,
  runBlocker,
  runFailureMessage,
  selectionFix,
  usableKeys,
  type AbandonedRun,
} from '../benchSession'
import { useSession } from './useSession'

const param = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

// 地址里的选择。只在测试台页面上读：离开时路由先变、组件后卸载，这段时间不跟着路由走
const selectionOf = (route: RouteLocationNormalizedLoaded) => ({
  spaceId: String(route.params.spaceId),
  app: param(route.query.app),
  key: param(route.query.key),
})

// 一次运行的结果。stale：运行期间换了应用、Key 或模式，结果作废（真实模式下记进 abandoned）；
// 或者上一次还没结束，这次没有发出去
export type RunOutcome =
  { kind: 'done'; result: BenchRunResult } | { kind: 'failed'; message: string } | { kind: 'stale' }

// 读到了、又不是还在刷新的旧缓存才算数：不能拿旧列表冤枉地址里的选择
const settledIds = (
  query: { isSuccess: Readonly<Ref<boolean>>; isFetching: Readonly<Ref<boolean>> },
  list: readonly { id: string }[],
) => (query.isSuccess.value && !query.isFetching.value ? list.map((item) => item.id) : null)

// 测试台各分页共享的状态：应用、Key、模式、会话上下文、这次会话。页面建一份，分页组件用 useBench 取同一份。
// 都只在内存里：调用内容可能有明文，不进浏览器存储
export function createBench() {
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

  // 地址里的应用或 Key 用不了（链接是别人的、Key 刚被吊销）时说一声，不悄悄换。
  // 地址同时改成实际的选择，所以只说一次：用户关掉或者重新选过之后不再提示，刷新之后也不会
  const selectionNotice = ref<string | null>(null)
  watch(spaceId, () => (selectionNotice.value = null))

  // 选择记在地址里：刷新、分享都还在。模式不记：真实模式每次都要确认
  const select = (query: { app?: string; key?: string }) =>
    void router.replace({ query: { ...route.query, ...query } })
  const selectApp = (id: string) => {
    selectionNotice.value = null
    select({ app: id, key: undefined })
  }
  const selectKey = (id: string) => {
    selectionNotice.value = null
    select({ key: id })
  }

  // 等 useQuery 跟上新的应用之后再判断（post）：它的选项在 pre 阶段才更新，那之前 keys.data 还是上一个应用的
  watchPostEffect(() => {
    // 离开时路由先变、组件后卸载，这段时间不能写到别的页面的地址上
    if (route.name !== 'bench') return
    const fix = selectionFix(
      selection,
      settledIds(apps, owned.value),
      settledIds(keys, usable.value),
    )
    if (!fix) return
    if (fix.notice) selectionNotice.value = fix.notice
    select(fix.query)
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
  // 换了应用、Key 或模式时清掉，进行中的那次就作废了，会话换一份新的；generation 让各分页清掉自己的结果
  let counter = 0
  const current = ref<number | null>(null)
  const running = computed(() => current.value !== null)
  const generation = ref(0)
  const session = shallowRef(emptySession())
  watch([spaceId, appId, keyId, mode], () => {
    current.value = null
    session.value = emptySession()
    generation.value++
  })

  // 真实模式的请求有几个还没回来，包括中途作废的
  const realInFlight = ref(0)
  // 中途作废、还没回来的：现在可能正在写入
  const abandonedInFlight = computed(
    () => realInFlight.value > (real.value && running.value ? 1 : 0),
  )
  // 中途作废的真实运行。不随换应用、Key 或模式清掉：作废就是因为这些变了，用户看过之后自己关
  const abandoned = shallowRef<AbandonedRun[]>([])
  function dismissAbandoned(id: number) {
    abandoned.value = abandoned.value.filter((run) => run.id !== id)
  }

  // what：这次运行是什么、结果按什么看法显示，中途作废时靠它说明
  async function execute(
    steps: BenchStep[],
    what: { label: string; view: StepView },
    replay: BenchReplayStep[] = [],
  ): Promise<RunOutcome> {
    const forSpace = spaceId.value
    const forApp = app.value
    const forKey = key.value
    const forMode = mode.value
    if (running.value || !forApp || !forKey) return { kind: 'stale' }
    const id = ++counter
    current.value = id
    if (forMode === 'real') realInFlight.value++
    // 回滚模式作废了就丢掉：什么都没留下。真实模式下写入可能已经落库，要说出来，有结果就显示
    const staleOutcome = (settled: { result: BenchRunResult } | { error: unknown }): RunOutcome => {
      const run =
        forMode === 'real'
          ? abandonedRun({ id, ...what, app: forApp.name, key: forKey.name }, settled)
          : null
      if (run) abandoned.value = [...abandoned.value, run]
      return { kind: 'stale' }
    }
    try {
      const result = await api.benchRun(forSpace, forApp.id, forKey.id, {
        mode: forMode,
        steps,
        replay,
      })
      return current.value === id ? { kind: 'done', result } : staleOutcome({ result })
    } catch (err) {
      // 应用转给了别人、Key 刚被吊销：重新读一遍，选择跟着变
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        void queryClient.invalidateQueries({ queryKey: ['apps', forSpace] })
        void queryClient.invalidateQueries({ queryKey: ['keys', forSpace, forApp.id] })
      }
      return current.value === id
        ? { kind: 'failed', message: runFailureMessage(err, forMode) }
        : staleOutcome({ error: err })
    } finally {
      if (current.value === id) current.value = null
      if (forMode === 'real') {
        realInFlight.value--
        // 真实模式写了数据（出错也可能写了一部分）：记忆、活动、对象、凭据的缓存都不算数了
        void queryClient.invalidateQueries()
      }
    }
  }

  // 连续调用：带上这次会话已经做过的写步骤，结果记进时间线与重放日志
  async function call(steps: BenchStep[], label: string): Promise<RunOutcome> {
    const blocked = runBlocker(session.value, mode.value)
    if (blocked) return { kind: 'failed', message: blocked }
    const outcome = await execute(
      steps,
      { label, view: 'call' },
      replayFor(session.value, mode.value),
    )
    if (outcome.kind === 'done') session.value = recordRun(session.value, outcome.result)
    return outcome
  }
  // 运行期间不动会话：结果回来时，重放分叉的第几步与这次的写入都是按发出请求时的日志算的
  function clearSession() {
    if (running.value) return
    session.value = emptySession()
  }
  function acceptDiverged() {
    if (running.value) return
    session.value = acceptDivergence(session.value)
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
    abandoned,
    abandonedInFlight,
    dismissAbandoned,
    session,
    call,
    clearSession,
    acceptDiverged,
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
