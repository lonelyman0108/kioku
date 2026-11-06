import {
  CONVERT_VALUE_MIN_LENGTH,
  PLAINTEXT_CREDENTIAL,
  findPlaintextCredentials,
  isBootCandidate,
  type ConsoleMemoryView,
  type MemoryRecallStat,
  type MemoryView,
  type PersonaDetail,
} from '@kioku/contracts'

import { formatRelative, isExpired } from './time'

// 记忆详情的状态和说法

const DAY = 86_400_000
// 还剩这么几天到期的标出来
const SOON_DAYS = 7

export type ExpiryState = 'none' | 'later' | 'soon' | 'expired'

export function expiryState(validTo: string | null, now: Date = new Date()): ExpiryState {
  if (validTo === null) return 'none'
  if (isExpired(validTo, now)) return 'expired'
  return new Date(validTo).getTime() - now.getTime() <= SOON_DAYS * DAY ? 'soon' : 'later'
}

// 启动加载的标记说的是够不够格，不是一定加载
export const BOOT_HINT = '符合启动加载条件；实际是否加载取决于访问密钥的权限、继承覆盖和字数上限'

// 够格进启动加载的节点：contracts 的 isBootCandidate（和服务端的 BOOT_CANDIDATE 同一条规则），再除去已过期的。
// 服务端只给现在有效的，过期这一条是给载入之后才到期的记忆。管理界面的列表与详情只有目录里的记忆（有 URI），
// 视图里没有 form 这一项，按 curated 判断
export function isBootNode(
  memory: Pick<MemoryView, 'layer' | 'priority' | 'provenance' | 'sensitivity' | 'validTo'>,
  now: Date = new Date(),
): boolean {
  return isBootCandidate({ ...memory, form: 'curated' }) && !isExpired(memory.validTo, now)
}

type DisclosureFields = Pick<
  MemoryView,
  'disclosure' | 'layer' | 'priority' | 'provenance' | 'sensitivity' | 'validTo'
>

// 没写触发场景时的提示，写了的是 null。要补的是 warning，和服务端的 NEEDS_DISCLOSURE 同一条规则：概览的「未设触发场景」
// 只数这些，点「去补全」过来的列表也只列这些。启动加载的节点不靠触发场景被想起，不算要补的，是 muted。
// 一次判断给全：tone 决定颜色；文字两种情况不同，分不清颜色时也认得出来：要补的写「未设触发场景」，
// 启动加载的节点写明是启动加载。列表一行放不下长句，用 short。
// hint 说补全它有什么用：机密不进召回，启动加载不靠它，只有别的记忆才是召回更准
export interface MissingDisclosure {
  tone: 'warning' | 'muted'
  text: string
  short: string
  hint: string
}

const UNSET = '未设触发场景'

export function missingDisclosure(
  memory: DisclosureFields,
  now: Date = new Date(),
): MissingDisclosure | null {
  if (memory.disclosure?.trim()) return null
  if (isBootNode(memory, now)) {
    return {
      tone: 'muted',
      text: '启动加载不依赖触发场景',
      short: '启动加载',
      hint: '未被加载时（例如超出字数上限），补全后召回更准确。',
    }
  }
  return {
    tone: 'warning',
    text: UNSET,
    short: UNSET,
    hint:
      memory.sensitivity === 'secret'
        ? '机密内容不参与召回，只能按 URI 读取。写清在什么场景下需要它，便于判断是否读取。'
        : '补全后召回更准确。',
  }
}

type PlaintextFields = Pick<ConsoleMemoryView, 'content' | 'sensitivity' | 'plaintextIgnored'>

// 正文疑似明文、要提示：规则和列表的 plaintext 筛选一样。机密的正文是加密的，查看之后界面上有正文也不算；
// 提示被忽略了的不算
export const looksPlaintext = (memory: PlaintextFields) =>
  !!memory.content &&
  memory.sensitivity !== 'secret' &&
  !memory.plaintextIgnored &&
  PLAINTEXT_CREDENTIAL.test(memory.content)

// 正文里疑似明文的那几段，要标出来。渲染之后的正文和原文对不上位置，只能按字面找，
// 所以太短的不标（下限和转存一样）：「密码：1」不能把全文的 1 都标红
export function plaintextValues(memory: PlaintextFields): string[] {
  if (!looksPlaintext(memory)) return []
  const text = memory.content!
  return findPlaintextCredentials(text)
    .map((m) => text.slice(m.start, m.end))
    .filter((value) => value.length >= CONVERT_VALUE_MIN_LENGTH)
}

// 这次改动动没动统计里的数：层、敏感级、有效与否、要不要补触发场景（missingDisclosure 是 warning 的才算，
// 改优先级也可能进出启动加载）、是不是疑似明文。
// 窄柱和列表上方的总数靠概览接口算，它要把整个概览算一遍，别的改动不用为它重取
export function statsChanged(before: ConsoleMemoryView, after: ConsoleMemoryView): boolean {
  const needsDisclosure = (memory: ConsoleMemoryView) =>
    missingDisclosure(memory)?.tone === 'warning'
  return (
    before.id !== after.id ||
    before.layer !== after.layer ||
    before.sensitivity !== after.sensitivity ||
    isExpired(before.validTo) !== isExpired(after.validTo) ||
    needsDisclosure(before) !== needsDisclosure(after) ||
    looksPlaintext(before) !== looksPlaintext(after)
  )
}

// 这个人格的节点覆盖了祖先的哪个节点。接口按祖先的节点记 overriddenBy，所以从 inherited 里反查
export function overriddenNode(
  detail: PersonaDetail | undefined,
  uri: string,
): { uri: string; persona: string } | null {
  const node = detail?.inherited.find((n) => n.overriddenBy === uri)
  if (!node) return null
  const persona = detail?.ancestors.find((a) => a.id === node.personaId)
  return { uri: node.uri, persona: persona?.name ?? '祖先人格' }
}

// 记忆的来源范围（originScope，写成 app:<id> 这样）。记忆只来自全局或某个应用，群和私聊写下的在联系人层
export function originScopeLabel(scope: string, appName: (id: string) => string | undefined) {
  const [kind, id] = scope.split(':')
  if (kind === 'global') return '全局'
  if (kind === 'app') {
    const name = id ? appName(id) : undefined
    return name ? `应用「${name}」` : '应用'
  }
  if (kind === 'group') return '群聊'
  if (kind === 'direct') return '私聊'
  return scope
}

// 召回的那一行。机密不进召回；启动加载不记成召回，够格的节点没有次数时不说「尚未召回」，但也不断言它一定加载了
export function recallText(
  stat: MemoryRecallStat | undefined,
  memory: { secret: boolean; boot: boolean },
  now: Date = new Date(),
): string {
  if (memory.secret) return '机密内容不参与召回'
  if (stat?.total) {
    const counted = `${stat.total} 次（保留期内 ${stat.recent} 次）`
    return stat.lastRecalledAt
      ? `${counted}，最近 ${formatRelative(stat.lastRecalledAt, now)}`
      : counted
  }
  if (memory.boot) return '符合启动加载条件'
  return stat ? '尚未召回' : '–'
}
