import type {
  BenchAssertion,
  BenchChanges,
  BenchInternalDetail,
  BenchSessionStart,
  BenchStepResult,
  BenchStepStatus,
} from '@kioku/contracts'

import { icons } from './icons'
import { changeLabels, credentialChangeLabels, credentialEventLabels, eventLabel } from './labels'

// 测试台一步的结果怎么显示：调用台、场景与模型对话共用

type BadgeColor = 'success' | 'error' | 'warning' | 'neutral'
export interface StepBadge {
  label: string
  color: BadgeColor
  icon: string
}

const STATUS_BADGES: Record<BenchStepStatus, StepBadge> = {
  passed: { label: '通过', color: 'success', icon: icons.passed },
  failed: { label: '失败', color: 'error', icon: icons.failed },
  // 跳过是不满足前提，不算失败；没有执行算失败，但和断言不成立不是一回事
  skipped: { label: '跳过', color: 'neutral', icon: icons.skipped },
  notRun: { label: '没有执行', color: 'warning', icon: icons.notRun },
}

// 看结果的方式。judged：场景，按断言判通过与失败；
// call：调用台没有断言，服务端一律算「通过」，这里只说这一步报没报错；
// probe：权限探测只列结果，不判通过与失败，每把 Key 的正确结果都不同
export type StepView = 'judged' | 'call' | 'probe'

export function stepBadge(step: BenchStepResult, view: StepView): StepBadge {
  if (view === 'judged' || step.status === 'skipped' || step.status === 'notRun') {
    return STATUS_BADGES[step.status]
  }
  if (step.internalError) return { label: '内部错误', color: 'error', icon: icons.error }
  // 没有响应：还没发出去就算失败了，例如依赖的变量没有取到
  if (step.raw === null) return STATUS_BADGES.notRun
  const quiet = view === 'probe'
  return step.isError
    ? { label: '报错', color: quiet ? 'neutral' : 'error', icon: icons.error }
    : { label: quiet ? '有结果' : '成功', color: quiet ? 'neutral' : 'success', icon: icons.passed }
}

// 这一步没有发出去，徽章显示「没有执行」：服务端记成 notRun 的，以及还没发出去就算失败的（依赖的变量没有取到）
export const notExecuted = (step: BenchStepResult) =>
  step.status === 'notRun' ||
  (step.status !== 'skipped' && !step.internalError && step.raw === null)

// capture 取不到的说明是服务端的 runner 写的，以 capture 开头；expect 的断言都不是这样开头
const missedCapture = (assertion: BenchAssertion) =>
  !assertion.ok && assertion.message.startsWith('capture ')

// 工具没报错、结果里却取不到 capture 要的内容。工具报错（被拒绝）时本来就取不到，那是探测的结果
export const captureMissed = (step: BenchStepResult) =>
  step.raw !== null && !step.isError && !step.internalError && step.assertions.some(missedCapture)

// 这一步列出哪些断言。权限探测不列断言的对错，只说明步骤为什么没有发出去、capture 为什么没取到
export function shownAssertions(step: BenchStepResult, view: StepView): BenchAssertion[] {
  if (view !== 'probe' || step.raw === null) return step.assertions
  return captureMissed(step) ? step.assertions.filter(missedCapture) : []
}

export const stepKindLabels: Record<BenchStepResult['kind'], string> = {
  tool: 'MCP 工具',
  lifecycle: '生命周期事件',
  recall: '/recall',
  boot: '/boot',
  whoami: '/whoami',
}

export const internalDetailLabels: Record<BenchInternalDetail, string> = {
  lock_timeout: '等锁超时：这条记录或这个 URI 被别的连接占着，或者这次运行里前面的步骤还没放锁',
  statement_timeout: '语句超时',
  run_timeout: '这次运行超过了总时长',
  aborted: '根事务已中止，后面的步骤都不会执行',
}

export const internalErrorText = (step: Pick<BenchStepResult, 'internalDetail'>) =>
  step.internalDetail ? internalDetailLabels[step.internalDetail] : '原因写进了服务端的日志'

// 这一步报了错（不算内部错误）时怎么说。按断言看的场景里，通过的步骤报错是预期之中或者没带断言，不用红字
export function errorNote(
  step: BenchStepResult,
  view: StepView,
): { text: string; alarming: boolean } | null {
  if (!step.isError || step.internalError) return null
  const text = '这一步报错了，原因见下面收到的原文。'
  if (view === 'call') return { text, alarming: true }
  if (view === 'probe') return { text, alarming: false }
  if (step.status !== 'passed') return { text, alarming: true }
  return {
    text: step.assertions.length
      ? '这一步报错了，符合断言。'
      : '这一步报错了：没带断言的步骤只要不是内部错误就算通过。',
    alarming: false,
  }
}

// turn.end 成功了却没有写进缓冲：这种情况不报错（宿主不用管），看不到原因的话会以为抽取的链路通了。
// 真实模式下 turns 是 null，不列
export const turnNotBuffered = (step: BenchStepResult) =>
  step.replay?.kind === 'lifecycle' && step.changes?.turns === 0

export const VECTOR_SKIPPED_NOTE =
  '这一步只走了全文与关键词：查询向量在开事务之前算好，这个查询没有算到（依赖前面步骤的结果，或者嵌入接口出错、超时）。'

const DROPPED_LABELS: Record<BenchSessionStart['dropped'][number], string> = {
  recent: '近期更新的记忆',
  related: '与当前项目相关的记忆',
}

// session.start 多带的三项：宿主能完整接收的字数、没展开的节点、放不下的附加块
export function sessionNotes(session: BenchSessionStart, text: string) {
  return {
    size:
      session.limit === null
        ? `共 ${text.length} 字，这种宿主没有字数上限`
        : `共 ${text.length} 字，宿主能完整接收 ${session.limit} 字`,
    overLimit: session.limit !== null && text.length > session.limit,
    omitted: session.omitted,
    dropped: session.dropped.map((d) => DROPPED_LABELS[d]),
  }
}

// 「这一步改了什么」的一行
export interface ChangeItem {
  // 做了什么：新建、修改、取用凭据……
  action: string
  // 改了谁：URI、凭据标识；没有时为 null
  target: string | null
  // 改了哪些字段
  fields: string[]
  // 要提醒的后果
  warnings: string[]
  notes: string[]
}

const KIND_LABELS: Record<NonNullable<BenchChanges['identities']>[number]['kind'], string> = {
  person: '人',
  group: '群',
}

// 只给字段名与个数，不带内容（对话缓冲只回显这一步自己传入的那一轮）。每一类都要列出来
export function changeItems(changes: BenchChanges): ChangeItem[] {
  const items: ChangeItem[] = []
  const add = (item: Partial<ChangeItem> & { action: string }) =>
    items.push({ target: null, fields: [], warnings: [], notes: [], ...item })

  for (const m of changes.memories) {
    add({
      action: eventLabel(m.type).label,
      target: m.uri,
      fields: m.fields.map((f) => changeLabels[f] ?? f),
      warnings: m.becameSecret ? ['改成了 secret：这条记忆历史里的正文会被抹掉，向量会删'] : [],
      notes: m.left ? ['改后这把 Key 看不到它了：这里是改前的 URI，不给改后的任何内容'] : [],
    })
  }
  if (changes.hiddenReleased) {
    add({ action: `让出了 ${changes.hiddenReleased} 条看不到的过期记录（别的成员的）` })
  }
  if (changes.hiddenOther) {
    add({ action: `另外有 ${changes.hiddenOther} 处改动看不到（这把 Key 能写却读不到的层）` })
  }
  for (const c of changes.credentials) {
    add({
      action: `凭据：${credentialEventLabels[c.type]?.label ?? c.type}`,
      target: c.identifier,
      fields: [...c.fields, ...c.changes.map((x) => credentialChangeLabels[x] ?? x)],
    })
  }
  if (changes.subjects) {
    add({
      action: `新建了 ${changes.subjects} 个对象`,
      warnings: ['真执行时对象没有删除接口，只能合并'],
    })
  }
  for (const identity of changes.identities ?? []) {
    add({ action: `新的平台账号：${KIND_LABELS[identity.kind]} · ${identity.platform}` })
  }
  if (changes.turns) {
    add({
      action: `写进对话缓冲 ${changes.turns} 轮`,
      notes: ['真执行时攒批之后排抽取'],
    })
  }
  return items
}

// 真实模式下对象与对话缓冲没有标记，这几项是 null，不能说成「没有改」
export const changesNotListed = (changes: BenchChanges) =>
  changes.subjects === null || changes.identities === null || changes.turns === null
