import {
  BENCH_MAX_REPLAY_BYTES,
  BENCH_MAX_REPLAY_STEPS,
  isReplayStep,
  type AppInfo,
  type BenchMode,
  type BenchReplayStep,
  type BenchRunResult,
  type BenchStepResult,
  type KeyInfo,
  type WhoAmI,
} from '@kioku/contracts'

import { ApiError } from './api/client'
import { formatBytes } from './backup'
import type { StepView } from './benchResult'

// 测试台的共享逻辑：谁能用、选择写回地址、真实模式的后果、运行失败与中途作废的说明、
// 切换模式会清掉什么、连续调用（重放日志与时间线）

// 只有应用主人能用测试台（会读到主人的私人层，空间 owner 也不行），所以只列自己是主人的应用
export const ownedApps = (apps: readonly AppInfo[], accountId: string | undefined) =>
  apps.filter((app) => app.ownerAccountId === accountId)

// 只能用还有效的 Key：吊销的、主人离开过空间而作废的都不列
export const usableKeys = (keys: readonly KeyInfo[]) => keys.filter((key) => key.effectiveScopes)

export const APP_REPLACED_NOTICE =
  '选中的应用不是你的，或者已经转走、删掉了：只有应用主人能用测试台。这里换成了你自己的另一个应用。'
export const KEY_REPLACED_NOTICE =
  '选中的 Key 已经失效或不属于这个应用：这里换成了它别的有效 Key，权限可能不同。'

export interface SelectionFix {
  // 要写回地址的参数，undefined 表示去掉
  query: { app?: string; key?: string }
  // 换掉了地址里原来的选择时才有；只是把默认选中的写上去时是 null
  notice: string | null
}

// 地址里的选择和读到的列表对一对，解析出的写回地址。默认选中的也要固定下来：不然默认的一变（新签发的 Key 排到前面、
// 默认的 Key 被吊销），界面就悄悄换成另一把权限可能完全不同的 Key，地址里又没有东西可比，给不出提示。
// apps、keys 是自己的应用、这个应用有效的 Key 的 id，没读到时是 null，这时不判断。
// 一个都没有时也不动：没有可换的，不能说换了（页面上另有「还没有」的说明）
export function selectionFix(
  selected: { app?: string | undefined; key?: string | undefined },
  apps: readonly string[] | null,
  keys: readonly string[] | null,
): SelectionFix | null {
  const firstApp = apps?.[0]
  if (!firstApp) return null
  if (!selected.app) return { query: { app: firstApp }, notice: null }
  // 地址里的 Key 是原来那个应用的，留着只会再提示一次
  if (!apps.includes(selected.app)) {
    return { query: { app: firstApp, key: undefined }, notice: APP_REPLACED_NOTICE }
  }
  const firstKey = keys?.[0]
  if (!firstKey || (selected.key && keys.includes(selected.key))) return null
  return { query: { key: firstKey }, notice: selected.key ? KEY_REPLACED_NOTICE : null }
}

// 切到真实模式、在真实模式下运行场景之前都列出这些后果，由用户确认
export const REAL_MODE_CONSEQUENCES = [
  '写入是真的：步骤和这把 Key 的真实调用一样落库，不回滚，排向量与抽取任务。',
  '新建的对象没有删除接口，只能合并：带私聊、群聊或频道上下文的步骤，第一次见到的平台账号会新建对象。',
  'turn.end 会把这一轮放进对话缓冲，攒批之后排抽取（要花模型的 token，抽取的事实写进对象层）。',
  '写下的事件带「测试台」标记与你的账号，在活动和凭据的访问记录里看得到。',
] as const

// 一次运行的结果。stale：运行期间换了应用、Key 或模式，结果作废（真实模式下记进 abandoned）；
// 或者上一次还没结束，这次没有发出去
export type RunOutcome =
  { kind: 'done'; result: BenchRunResult } | { kind: 'failed'; message: string } | { kind: 'stale' }

export const NOT_API_FAILURE = '网络出错了，或者响应对不上'

// 4xx 是写入之前就拒绝了（429 同时运行的回滚太多、413 请求体太大、403、404）
const refusedBeforeWrite = (err: unknown) => err instanceof ApiError && err.status < 500

// 运行请求失败的说明。5xx 与网络错误不知道执行到了哪一步：回滚模式下都回滚了，真实模式下可能已经写了一部分
export function runFailureMessage(err: unknown, mode: BenchMode): string {
  const message = err instanceof ApiError ? err.message : `运行失败：${NOT_API_FAILURE}`
  return mode === 'real' && !refusedBeforeWrite(err)
    ? `${message}。可能已经执行了一部分，到活动里确认`
    : message
}

export const catalogFailure = (err: unknown) =>
  `读取工具目录失败：${err instanceof ApiError ? err.message : NOT_API_FAILURE}`

// 真实模式的一次运行中途作废了：运行期间应用、Key 或模式变了（例如 Key 被吊销）。
// 它的结果不属于现在的选择，进不了时间线，但写入可能已经落库，不能不说
export interface AbandonedRun {
  id: number
  title: string
  description: string
  view: StepView
  // 请求出错时没有结果
  result: BenchRunResult | null
}

// 作废的那次运行回来了怎么说。写入之前就被拒绝的什么都没发生，没有要说的（回滚模式同理，不用到这里来）
export function abandonedRun(
  run: { id: number; label: string; view: StepView; app: string; key: string },
  settled: { result: BenchRunResult } | { error: unknown },
): AbandonedRun | null {
  if ('error' in settled && refusedBeforeWrite(settled.error)) return null
  const { id, view } = run
  const title =
    '这次真实运行中途作废了（运行期间应用、Key 或模式变了），但可能已经写入：到活动里确认。'
  const what = `「${run.label}」按「${run.app}」的 Key「${run.key}」真实执行`
  if ('result' in settled) {
    return { id, title, description: `${what}，下面是它的结果。`, view, result: settled.result }
  }
  const reason = settled.error instanceof ApiError ? settled.error.message : NOT_API_FAILURE
  const description = `${what}，请求出错了，没有拿到结果：${reason}`
  return { id, title, description, view, result: null }
}

// 切换模式时一起清掉的记录
export interface ModeRecords {
  // 调用台时间线的条数
  timeline: number
  // 回滚模式下保留的写入的步数：调用台与模型对话各有一份，加起来算
  replay: number
  scenarioResult: boolean
  // 调用台或场景有运行失败的说明
  failed: boolean
  // 模型对话的用户消息条数
  agentMessages: number
}

// 从这个模式切走会清掉什么。什么都不会清时是 null，切回回滚就不用多问。
// 真实模式下要说得更清楚：结果里的运行标记是活动里对应这些写入的线索，失败的说明可能写着已经执行了一部分
export function modeSwitchLoss(from: BenchMode, records: ModeRecords): string | null {
  const { timeline, replay, scenarioResult, failed, agentMessages } = records
  const items = [
    ...(timeline ? [`调用台的时间线（${timeline} 条）`] : []),
    ...(scenarioResult ? ['场景结果'] : []),
    ...(agentMessages ? [`模型对话（${agentMessages} 条消息）`] : []),
    ...(failed ? ['运行失败的说明'] : []),
  ].join('、')
  if (!items) return null
  if (from === 'rollback') {
    return `这些记录会清掉：${items}。${replay ? '回滚模式下保留的写入不会带过去。' : ''}`
  }
  const markers =
    timeline || scenarioResult || agentMessages ? '，以及运行标记（活动里靠它对应这些写入）' : ''
  return `这些记录会清掉：${items}${markers}。已经写下的不会撤回。`
}

// 时间线只留最近这么多条，全在内存里：结果可能很长，也可能有明文，不进浏览器存储
export const BENCH_TIMELINE_MAX = 200

export interface TimelineEntry {
  id: number
  // 这次运行的标记，步骤里的 ${run} 就是它
  run: string
  whoami: WhoAmI
  step: BenchStepResult
  // 这一步的写入在重放日志里，后面的调用读得到
  kept: boolean
  // 这一步的写入进过重放日志，接受重放分叉时去掉了，后面的调用读不到
  removed: boolean
}

// 这次会话。回滚模式下每次运行都在新的事务里、结束就回滚，「后面的调用读得到前面的写入」靠重放日志：
// 下一次运行先把它们再执行一遍。换了应用、Key 或模式就换一份新的
export interface BenchSession {
  // 已经成功做过的写步骤。参数是服务端返回的展开之后的（${run} 与 capture 不再求值）
  replay: BenchReplayStep[]
  // 重放日志每一项是时间线上的哪一条，和 replay 一一对应
  replayEntryIds: number[]
  timeline: TimelineEntry[]
  // 时间线上丢掉的最早的条数
  dropped: number
  // 有写步骤放不进重放日志：后面的调用读不到它的写入，和这次会话的状态对不上，要清空才能接着来
  overflow: boolean
  // 上一次运行重放时报错了，这次的步骤都没有执行，由用户清空或接受
  diverged: BenchRunResult['replayDiverged']
  nextId: number
}

export const emptySession = (): BenchSession => ({
  replay: [],
  replayEntryIds: [],
  timeline: [],
  dropped: 0,
  overflow: false,
  diverged: null,
  nextId: 1,
})

const replayBytes = (replay: readonly BenchReplayStep[]) =>
  new TextEncoder().encode(JSON.stringify(replay)).length

// 和服务端校验运行请求的上限相同：超过了请求会被整个拒绝
const fitsReplay = (replay: readonly BenchReplayStep[]) =>
  replay.length <= BENCH_MAX_REPLAY_STEPS && replayBytes(replay) <= BENCH_MAX_REPLAY_BYTES

// 这一步要记进重放日志的样子：只记成功的写步骤。服务端只对这些给 replay，这里再按契约的判定确认一次，
// 不让日志里混进别的步骤（读的结果不留下，重放了也没有意义）
export function replayEntryOf(step: BenchStepResult): BenchReplayStep | null {
  if (!step.replay || step.isError || step.internalError) return null
  return isReplayStep(step.replay) ? step.replay : null
}

// 记下一次运行：时间线加上这次的步骤，重放日志加上成功的写步骤。真实模式写入已经生效，不重放
export function recordRun(session: BenchSession, result: BenchRunResult): BenchSession {
  let { replay, replayEntryIds, overflow, nextId } = session
  const entries = result.steps.map((step): TimelineEntry => {
    const id = nextId++
    const entry = result.mode === 'rollback' ? replayEntryOf(step) : null
    let kept = false
    // 放不下之后后面的也不记：重放日志要和实际做过的顺序一致，不能跳过一步接着记
    if (entry && !overflow) {
      const next = [...replay, entry]
      if (fitsReplay(next)) {
        replay = next
        replayEntryIds = [...replayEntryIds, id]
        kept = true
      } else {
        overflow = true
      }
    }
    return { id, run: result.run, whoami: result.whoami, step, kept, removed: false }
  })
  const timeline = [...session.timeline, ...entries]
  const dropped = Math.max(0, timeline.length - BENCH_TIMELINE_MAX)
  return {
    replay,
    replayEntryIds,
    timeline: timeline.slice(dropped),
    dropped: session.dropped + dropped,
    overflow,
    diverged: result.replayDiverged,
    nextId,
  }
}

// 这次运行要带上的重放。真实模式不重放（运行请求的契约也不接受）
export const replayFor = (session: BenchSession, mode: BenchMode): BenchReplayStep[] =>
  mode === 'rollback' ? session.replay : []

// 现在为什么不能接着运行，能运行时是 null
export function runBlocker(session: BenchSession, mode: BenchMode): string | null {
  if (mode !== 'rollback' || !session.overflow) return null
  return `这次会话的写入放不进重放日志了（上限 ${BENCH_MAX_REPLAY_STEPS} 步、${formatBytes(BENCH_MAX_REPLAY_BYTES)}）：后面的调用读不到它们，清空之后再接着来`
}

// 接受重放分叉：去掉报错的那一步，留下别的接着用。再运行时后面依赖它的步骤可能接着报错，到时候再问一次。
// 时间线跟着改：去掉的那一条不能还标着已保留（它可能已经滚出了时间线，那就没有要改的）
export function acceptDivergence(session: BenchSession): BenchSession {
  const { diverged } = session
  if (!diverged) return session
  const removedId = session.replayEntryIds[diverged.index]
  const keep = (_: unknown, index: number) => index !== diverged.index
  return {
    ...session,
    replay: session.replay.filter(keep),
    replayEntryIds: session.replayEntryIds.filter(keep),
    timeline: session.timeline.map((entry) =>
      entry.id === removedId ? { ...entry, kept: false, removed: true } : entry,
    ),
    diverged: null,
  }
}

export function replayStepLabel(step: BenchReplayStep): string {
  if (step.kind === 'lifecycle') return `turn.end ${step.body.sessionId}`
  const { uri, from, identifier } = step.arguments
  const target = uri ?? from ?? identifier
  return typeof target === 'string' ? `${step.tool} ${target}` : step.tool
}

// 重放分叉的说明：第几步（从 1 算）、它的错误、怎么办。现在的数据和这次会话做这一步时不一样了才会报错，
// 回滚模式本来就是对着当前数据演练，不算出错，由用户决定
export function divergenceNotice(
  session: BenchSession,
): { title: string; description: string } | null {
  const { diverged, replay } = session
  if (!diverged) return null
  const step = replay[diverged.index]
  const which = `第 ${diverged.index + 1} 步${step ? `（${replayStepLabel(step)}）` : ''}`
  return {
    title: `重放的${which}报错，这次的调用没有执行`,
    description: diverged.internalError
      ? `${diverged.text}。可能是暂时的，可以再运行一次；还是不行就清空，或者接受：去掉这一步，留下别的接着用。`
      : `${diverged.text}。现在的数据和这次会话做这一步时不一样了。可以清空，或者接受：去掉这一步，留下别的接着用，后面依赖它的步骤可能接着报错。`,
  }
}

// 这次会话留下了什么，一句话说完
export function sessionUsage(session: BenchSession, mode: BenchMode): string {
  if (mode === 'real') return '真实模式不重放：每一步都已经真实执行。'
  const { length } = session.replay
  if (!length) return '还没有保留的写入。回滚模式下成功的写步骤留在这里，后面的调用读得到它们。'
  return `保留了 ${length} 步写入（${formatBytes(replayBytes(session.replay))}，上限 ${BENCH_MAX_REPLAY_STEPS} 步、${formatBytes(BENCH_MAX_REPLAY_BYTES)}）。都不会落库，后面的调用靠重放读得到它们。`
}
