import {
  mayWrite,
  type AppInfo,
  type BenchAgentLoop,
  type BenchAgentTurnRequest,
  type BenchMode,
  type BenchReplayStep,
  type BenchRunResult,
  type BenchStep,
  type KeyInfo,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  computed,
  inject,
  onScopeDispose,
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
import { emptyConversation, sendAgentMessage, type AgentExchange } from '../benchAgent'
import { contextDefaults, contextOf } from '../benchForm'
import type { StepView } from '../benchResult'
import type { ScenarioOutcome } from '../benchScenarios'
import {
  abandonedRun,
  acceptDivergence,
  emptySession,
  modeSwitchLoss,
  ownedApps,
  recordRun,
  replayFor,
  runBlocker,
  runFailureMessage,
  selectionFix,
  usableKeys,
  type AbandonedRun,
  type RunOutcome,
} from '../benchSession'
import { useUnsavedChangesGuard } from './unsavedChanges'
import { useSession } from './useSession'

const param = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

// 地址里的选择。只在测试台页面上读：离开时路由先变、组件后卸载，这段时间不跟着路由走
const selectionOf = (route: RouteLocationNormalizedLoaded) => ({
  spaceId: String(route.params.spaceId),
  app: param(route.query.app),
  key: param(route.query.key),
})

// 一次运行对着谁。发请求之前就定下来：一条消息的循环中途不能换成别的 Key
interface RunTarget {
  space: string
  app: AppInfo
  key: KeyInfo
  mode: BenchMode
}

// 读到了、又不是还在刷新的旧缓存才算数：不能拿旧列表冤枉地址里的选择
const settledIds = (
  query: { isSuccess: Readonly<Ref<boolean>>; isFetching: Readonly<Ref<boolean>> },
  list: readonly { id: string }[],
) => (query.isSuccess.value && !query.isFetching.value ? list.map((item) => item.id) : null)

// 测试台各分页共享的状态：应用、Key、模式、会话上下文、这次会话、模型对话。页面建一份，分页组件用 useBench 取同一份。
// 都只在内存里：调用内容可能有明文，不进浏览器存储
export function createBench() {
  const route = useRoute()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { me } = useSession()

  // 选择记在地址里：刷新、分享都还在。模式不记：真实模式每次都要确认
  const select = (query: { app?: string; key?: string }) =>
    void router.replace({ query: { ...route.query, ...query } })

  const selection = reactive(selectionOf(route))
  watch(
    () => route.fullPath,
    () => {
      if (route.name !== 'bench') return
      const next = selectionOf(route)
      // 侧栏的入口不带参数，点它不算换选择：不然默认的那把变过的话，这里就悄悄换了
      if (next.spaceId === selection.spaceId && !next.app && !next.key && selection.app) {
        select({ app: selection.app, key: selection.key })
        return
      }
      Object.assign(selection, next)
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
  const confirmingRollback = ref(false)
  // 换了应用或 Key 就回到回滚：真实模式是对着这把 Key 确认的
  watch([spaceId, appId, keyId], () => {
    mode.value = 'rollback'
    confirmingReal.value = false
    confirmingRollback.value = false
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
  // 模型对话，和调用台的会话分开。发给模型的内容都是这把 Key 读得到的，对话属于这把 Key，也属于这个模式
  const agent = shallowRef(emptyConversation())
  // 一条消息的循环进行中时有它，停止与换选择都靠它取消模型请求
  const agentController = shallowRef<AbortController | null>(null)
  const agentSending = computed(() => agentController.value !== null)
  const agentStopping = ref(false)
  watch([spaceId, appId, keyId, mode], () => {
    current.value = null
    session.value = emptySession()
    generation.value++
    // 进行中的那条消息作废，模型请求一起取消，别继续花 token
    agentController.value?.abort()
    agentController.value = null
    agentStopping.value = false
    agent.value = emptyConversation()
  })
  // 离开页面：同样不继续花 token
  onScopeDispose(() => agentController.value?.abort())

  // 分页手上的结果与报错放在这里：切模式时它们跟着 generation 清掉，切之前要说清楚清掉什么
  const callFailure = ref<string | null>(null)
  const scenarioFailure = ref<string | null>(null)
  const scenarioOutcome = shallowRef<ScenarioOutcome | null>(null)
  const modeLoss = computed(() =>
    modeSwitchLoss(mode.value, {
      timeline: session.value.timeline.length,
      replay: session.value.replay.length + agent.value.session.replay.length,
      scenarioResult: Boolean(scenarioOutcome.value),
      failed: Boolean(callFailure.value || scenarioFailure.value),
      agentMessages: agent.value.exchanges.length,
    }),
  )
  // 切回回滚的确认框的正文，打开时存一份：确认之后记录马上清掉，modeLoss 就没了，关闭动画期间不能只剩标题
  const rollbackLoss = ref('')
  // 切到真实每次都要确认；切回回滚只在会清掉记录时确认，没有东西可清时不多问
  function requestMode(wantReal: boolean) {
    if (wantReal) confirmingReal.value = true
    else if (modeLoss.value) {
      rollbackLoss.value = modeLoss.value
      confirmingRollback.value = true
    } else mode.value = 'rollback'
  }
  function confirmReal() {
    confirmingReal.value = false
    mode.value = 'real'
  }
  function confirmRollback() {
    confirmingRollback.value = false
    mode.value = 'rollback'
  }

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

  // 离开页面会丢的：分页报上来的（场景文本框、调用台的 JSON 草稿，都只在内存里）、模型对话（只在内存里，
  // 两种模式都算：回滚模式下也是花了 token 聊出来的）、还没回来的真实运行（离开就看不到它写了什么）、
  // 真实模式留下的记录（时间线、场景结果、失败的说明、作废的运行：写入可能已经落库，结果里的运行标记是
  // 活动里对应它们的线索）。回滚模式的结果不算：什么都没留下。
  // 换应用、Key、分页只改查询参数，页面还在，不算离开
  const unsaved = reactive({ scenario: false, drafts: false })
  useUnsavedChangesGuard(
    computed(
      () =>
        unsaved.scenario ||
        unsaved.drafts ||
        agent.value.exchanges.length > 0 ||
        realInFlight.value > 0 ||
        (real.value && modeLoss.value !== null) ||
        abandoned.value.length > 0,
    ),
    { leavesOn: (to, from) => to.params.spaceId !== from.params.spaceId },
  )

  const runTarget = (): RunTarget | null =>
    app.value && key.value
      ? { space: spaceId.value, app: app.value, key: key.value, mode: mode.value }
      : null

  // 应用转给了别人、Key 刚被吊销：重新读一遍，选择跟着变
  function refetchIfDenied(err: unknown, { space, app: forApp }: RunTarget) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      void queryClient.invalidateQueries({ queryKey: ['apps', space] })
      void queryClient.invalidateQueries({ queryKey: ['keys', space, forApp.id] })
    }
  }

  // 发一次运行，结果归序号 id 的那次。what：这次运行是什么、结果按什么看法显示，中途作废时靠它说明
  async function runAs(
    id: number,
    target: RunTarget,
    steps: BenchStep[],
    what: { label: string; view: StepView },
    replay: BenchReplayStep[],
  ): Promise<RunOutcome> {
    const { space: forSpace, app: forApp, key: forKey, mode: forMode } = target
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
      refetchIfDenied(err, target)
      return current.value === id
        ? { kind: 'failed', message: runFailureMessage(err, forMode) }
        : staleOutcome({ error: err })
    } finally {
      if (forMode === 'real') {
        realInFlight.value--
        // 真实模式写了数据（出错也可能写了一部分）：记忆、活动、对象、凭据的缓存都不算数了
        void queryClient.invalidateQueries()
      }
    }
  }

  async function execute(
    steps: BenchStep[],
    what: { label: string; view: StepView },
    replay: BenchReplayStep[] = [],
  ): Promise<RunOutcome> {
    const target = runTarget()
    if (running.value || !target) return { kind: 'stale' }
    const id = ++counter
    current.value = id
    try {
      return await runAs(id, target, steps, what, replay)
    } finally {
      if (current.value === id) current.value = null
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

  // 请求一次模型。Key 被吊销时和运行一样让选择跟上；模型的设置变了（400）时重新读模型代理的情况
  async function agentTurn(target: RunTarget, body: BenchAgentTurnRequest, signal: AbortSignal) {
    try {
      return await api.benchAgentTurn(target.space, target.app.id, target.key.id, body, signal)
    } catch (err) {
      refetchIfDenied(err, target)
      if (err instanceof ApiError && err.status < 500) {
        void queryClient.invalidateQueries({ queryKey: ['bench-agent', target.space] })
      }
      throw err
    }
  }

  // 发一条消息给模型，走完它的循环。整个循环算一次运行，current 一直占着：模型请求之间没有运行在跑，
  // 但这段时间同样不能切换、不能跑别的调用（历史与重放日志都是按这把 Key 算的）。
  // 换了应用、Key 或模式时 current 被清掉，之后的结果都不算数，新的对话不会被旧的循环写回来。
  // 返回这条消息的经过；中途作废时是 null
  async function sendToAgent(
    text: string,
    options: { loop: BenchAgentLoop; system: string; model: string },
  ): Promise<AgentExchange | null> {
    const target = runTarget()
    if (running.value || !target) return null
    const id = ++counter
    current.value = id
    const controller = new AbortController()
    agentController.value = controller
    agentStopping.value = false
    // 这条消息里已经跑完的、可能写库的真实运行：循环中途作废时，它们的记录随对话一起清掉，要留下来说一声
    const written: { label: string; result: BenchRunResult }[] = []
    const what = (label: string) => ({ label, view: 'call' as const })
    try {
      const finished = await sendAgentMessage(agent.value, text, {
        ...options,
        mode: target.mode,
        context: sessionContext.value,
        signal: controller.signal,
        io: {
          turn: (body, signal) => agentTurn(target, body, signal),
          run: async (steps, replay, label) => {
            const outcome = await runAs(id, target, steps, what(label), replay)
            if (outcome.kind === 'done' && target.mode === 'real' && steps.some(mayWrite)) {
              written.push({ label, result: outcome.result })
            }
            return outcome
          },
        },
        onChange: (next) => {
          if (current.value === id) agent.value = next
        },
      })
      if (current.value === id) return finished.exchanges.at(-1) ?? null
      const { app: forApp, key: forKey } = target
      for (const { label, result } of written) {
        const run = { id: ++counter, ...what(label), app: forApp.name, key: forKey.name }
        const record = abandonedRun(run, { result })
        if (record) abandoned.value = [...abandoned.value, record]
      }
      return null
    } finally {
      if (current.value === id) current.value = null
      if (agentController.value === controller) {
        agentController.value = null
        agentStopping.value = false
      }
    }
  }
  // 停止之后不再发新的请求。正在等的模型请求马上取消；已经发出去的运行取消不了，等它回来
  function stopAgent() {
    if (!agentController.value) return
    agentStopping.value = true
    agentController.value.abort()
  }
  function clearAgent() {
    if (running.value) return
    agent.value = emptyConversation()
  }
  // 开始之前的提示点过了：这次对话里同一个模型不再问。循环进行时状态归它管，别的调用在跑时不相干
  function consentToModel(model: string) {
    if (agentSending.value) return
    agent.value = { ...agent.value, consentedModel: model }
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
    confirmingRollback,
    modeLoss,
    rollbackLoss,
    requestMode,
    confirmReal,
    confirmRollback,
    callFailure,
    scenarioFailure,
    scenarioOutcome,
    contextForm,
    sessionContext,
    running,
    generation,
    execute,
    abandoned,
    abandonedInFlight,
    dismissAbandoned,
    unsaved,
    session,
    call,
    clearSession,
    acceptDiverged,
    agent,
    agentSending,
    agentStopping,
    sendToAgent,
    stopAgent,
    clearAgent,
    consentToModel,
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
