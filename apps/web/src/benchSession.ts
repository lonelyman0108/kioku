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

// 测试台的共享逻辑：谁能用、真实模式的后果、运行失败的说明、连续调用（重放日志与时间线）

// 只有应用主人能用测试台（会读到主人的私人层，空间 owner 也不行），所以只列自己是主人的应用
export const ownedApps = (apps: readonly AppInfo[], accountId: string | undefined) =>
  apps.filter((app) => app.ownerAccountId === accountId)

// 只能用还有效的 Key：吊销的、主人离开过空间而作废的都不列
export const usableKeys = (keys: readonly KeyInfo[]) => keys.filter((key) => key.effectiveScopes)

// 切到真实模式、在真实模式下运行场景之前都列出这些后果，由用户确认
export const REAL_MODE_CONSEQUENCES = [
  '写入是真的：步骤和这把 Key 的真实调用一样落库，不回滚，排向量与抽取任务。',
  '新建的对象没有删除接口，只能合并：带私聊、群聊或频道上下文的步骤，第一次见到的平台账号会新建对象。',
  'turn.end 会把这一轮放进对话缓冲，攒批之后排抽取（要花模型的 token，抽取的事实写进对象层）。',
  '写下的事件带「测试台」标记与你的账号，在活动和凭据的访问记录里看得到。',
] as const

// 运行请求失败的说明。4xx 是写入之前就拒绝了（429 同时运行的回滚太多、413 请求体太大、403、404）；
// 5xx 与网络错误不知道执行到了哪一步：回滚模式下都回滚了，真实模式下可能已经写了一部分
export function runFailureMessage(err: unknown, mode: BenchMode): string {
  const message = err instanceof ApiError ? err.message : '运行失败：网络出错了，或者响应对不上'
  const refused = err instanceof ApiError && err.status < 500
  return mode === 'real' && !refused ? `${message}。可能已经执行了一部分，到活动里确认` : message
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
