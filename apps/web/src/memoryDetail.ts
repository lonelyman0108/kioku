import {
  PLAINTEXT_CREDENTIAL,
  bootEligible,
  findPlaintextCredentials,
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

// 每次会话开始时加载的节点：还有权限、继承覆盖和字数预算要过，这里只说它够格。过期了就不算
export function isBootNode(
  memory: Pick<MemoryView, 'layer' | 'priority' | 'provenance' | 'validTo'>,
  now: Date = new Date(),
): boolean {
  return (
    memory.provenance !== 'untrusted' &&
    bootEligible(memory.layer, memory.priority) &&
    !isExpired(memory.validTo, now)
  )
}

type PlaintextFields = Pick<ConsoleMemoryView, 'content' | 'sensitivity' | 'plaintextIgnored'>

// 正文疑似明文、要提示：规则和列表的 plaintext 筛选一样。机密的正文是加密的，查看之后界面上有正文也不算；
// 提示被忽略了的不算
export const looksPlaintext = (memory: PlaintextFields) =>
  !!memory.content &&
  memory.sensitivity !== 'secret' &&
  !memory.plaintextIgnored &&
  PLAINTEXT_CREDENTIAL.test(memory.content)

// 正文里疑似明文的那几段，要标出来
export function plaintextValues(memory: PlaintextFields): string[] {
  if (!looksPlaintext(memory)) return []
  const text = memory.content!
  return findPlaintextCredentials(text).map((m) => text.slice(m.start, m.end))
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

// 召回的那一行。机密不进召回；启动加载的节点每次会话开始都注入，不记成召回，没有次数时不说「尚未召回」
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
  if (memory.boot) return '启动加载，不经过召回'
  return stat ? '尚未召回' : '–'
}
