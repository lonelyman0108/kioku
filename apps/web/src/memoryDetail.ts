import {
  CONVERT_VALUE_MIN_LENGTH,
  PLAINTEXT_CREDENTIAL,
  findPlaintextCredentials,
  isBootCandidate,
  normalizeWhen,
  type ConsoleEntryView,
  type EntryRecallStat,
  type EntryView,
  type FacetVocabularyView,
} from '@kioku/contracts'

import { builtinFacetLabels } from './labels'
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
export const BOOT_HINT =
  '符合启动加载条件；实际是否加载取决于访问密钥的访问范围、适用条件匹配和字数上限'

// 够格进启动加载的词条：contracts 的 isBootCandidate（与服务端同一条规则），再除去已过期的
export function isBootNode(
  entry: Pick<EntryView, 'kind' | 'priority' | 'provenance' | 'sensitivity' | 'validTo'>,
  now: Date = new Date(),
): boolean {
  return isBootCandidate(entry) && !isExpired(entry.validTo, now)
}

type DisclosureFields = Pick<
  EntryView,
  'disclosure' | 'kind' | 'priority' | 'provenance' | 'sensitivity' | 'validTo'
>

// 没写触发场景时的提示，写了的是 null。要补的是 warning，和服务端的 NEEDS_DISCLOSURE 同一条规则：概览的「未设触发场景」
// 只数这些，点「去补全」过来的列表也只列这些。启动加载的词条不靠触发场景被想起，不算要补的，是 muted。
// 一次判断给全：tone 决定颜色；文字两种情况不同，分不清颜色时也认得出来
export interface MissingDisclosure {
  tone: 'warning' | 'muted'
  text: string
  short: string
  hint: string
}

const UNSET = '未设召回说明'

export function missingDisclosure(
  entry: DisclosureFields,
  now: Date = new Date(),
): MissingDisclosure | null {
  if (entry.kind !== 'entry' || entry.disclosure?.trim()) return null
  if (isBootNode(entry, now)) {
    return {
      tone: 'muted',
      text: '启动加载不依赖召回说明',
      short: '启动加载',
      hint: '未被加载时（例如超出字数上限），补全后召回更准确。',
    }
  }
  return {
    tone: 'warning',
    text: UNSET,
    short: UNSET,
    hint:
      entry.sensitivity === 'secret'
        ? '机密内容不参与召回，只能按短 ID 或标题读取。写清适用场景便于判断是否读取。'
        : '补全后召回更准确。',
  }
}

type VariantTextFields = { content: string | null; plaintextIgnored?: boolean }
type PlaintextFields = {
  sensitivity: ConsoleEntryView['sensitivity']
  plaintextIgnored: boolean
  variants?: readonly VariantTextFields[]
  content?: string | null
}

// 合并未忽略且已解密切片的正文，供多切片扫描或展示用
export function entryText(entry: Pick<PlaintextFields, 'variants' | 'content'>): string {
  if (entry.variants) {
    return entry.variants
      .filter((v) => !v.plaintextIgnored && v.content !== null)
      .map((v) => v.content!)
      .join('\n')
  }
  return entry.content ?? ''
}

// 正文疑似明文、要提示：规则和列表的 plaintext 筛选一样。机密的正文是加密的，查看之后界面上有正文也不算；
// 提示被忽略了的不算
export function looksPlaintext(entry: PlaintextFields): boolean {
  if (entry.sensitivity === 'secret' || entry.plaintextIgnored) return false
  if (entry.variants) {
    return entry.variants.some(
      (v) => !v.plaintextIgnored && !!v.content && PLAINTEXT_CREDENTIAL.test(v.content),
    )
  }
  return !!entry.content && PLAINTEXT_CREDENTIAL.test(entry.content)
}

// 单个切片内疑似明文的值，用于高亮标记
export function variantPlaintextValues(
  content: string | null,
  sensitivity: string,
  plaintextIgnored = false,
): string[] {
  if (sensitivity === 'secret' || plaintextIgnored || !content) return []
  return [
    ...new Set(
      findPlaintextCredentials(content)
        .map((m) => content.slice(m.start, m.end))
        .filter((value) => value.length >= CONVERT_VALUE_MIN_LENGTH),
    ),
  ]
}

// 正文里疑似明文的那几段，要标出来。太短的不标（下限和转存一样）：「密码：1」不能把全文的 1 都标红
export function plaintextValues(entry: PlaintextFields): string[] {
  if (!looksPlaintext(entry)) return []
  if (entry.variants) {
    const all = entry.variants.flatMap((v) =>
      variantPlaintextValues(v.content, entry.sensitivity, v.plaintextIgnored),
    )
    return [...new Set(all)]
  }
  return variantPlaintextValues(entry.content ?? null, entry.sensitivity, entry.plaintextIgnored)
}

// 这次改动动没动统计里的数：记忆圈、形态、敏感级、有效与否、要不要补召回说明、疑似敏感内容状态。
// 窄柱和列表上方的总数靠概览接口算，它要把整个概览算一遍，别的改动不用为它重取
function sensitiveSignature(entry: ConsoleEntryView): string {
  return [
    entry.plaintextIgnored ? '1' : '0',
    ...(entry.variants ?? []).map(
      (v) =>
        `${v.plaintextIgnored ? '1' : '0'}:${(v.sensitiveFindings ?? []).map((f) => `${f.kind}:${f.line}`).join(',')}`,
    ),
  ].join('|')
}

export function statsChanged(before: ConsoleEntryView, after: ConsoleEntryView): boolean {
  const needsDisclosure = (entry: ConsoleEntryView) => missingDisclosure(entry)?.tone === 'warning'
  return (
    before.id !== after.id ||
    before.circleId !== after.circleId ||
    before.kind !== after.kind ||
    before.sensitivity !== after.sensitivity ||
    isExpired(before.validTo) !== isExpired(after.validTo) ||
    needsDisclosure(before) !== needsDisclosure(after) ||
    looksPlaintext(before) !== looksPlaintext(after) ||
    sensitiveSignature(before) !== sensitiveSignature(after)
  )
}

// 词条的来源作用域（originScope，写成 client:<id>、group:<id>、direct:<id> 等）
export function originScopeLabel(
  scope: string,
  clientName: (id: string) => string | undefined,
): string {
  const [kind, id] = scope.split(':')
  if (kind === 'global') return '全局'
  if (kind === 'client') {
    const name = id ? clientName(id) : undefined
    return name ? `客户端「${name}」` : '客户端'
  }
  if (kind === 'group') return '群聊'
  if (kind === 'direct') return '私聊'
  return scope
}

// 把变体切片的 when 条件格式化为可读短标签
export function whenLabel(
  when: Record<string, readonly string[]>,
  vocabulary?: FacetVocabularyView,
): string {
  const normalized = normalizeWhen(when)
  const keys = Object.keys(normalized)
  if (!keys.length) return '默认（无条件）'
  return keys
    .map((dimKey) => {
      const dimName =
        vocabulary?.dimensions.find((d) => d.key === dimKey)?.name ??
        builtinFacetLabels[dimKey as keyof typeof builtinFacetLabels] ??
        dimKey
      const slugs = normalized[dimKey] ?? []
      const termNames = slugs.map(
        (slug) =>
          vocabulary?.terms.find((t) => t.dimensionKey === dimKey && t.slug === slug)?.label ??
          slug,
      )
      return `${dimName}: ${termNames.join(' / ')}`
    })
    .join(' · ')
}

// 召回的那一行。机密不进召回；启动加载不记成召回，够格的词条没有次数时不说「尚未召回」，但也不断言它一定加载了
export function recallText(
  stat: EntryRecallStat | undefined,
  entry: { secret: boolean; boot: boolean },
  now: Date = new Date(),
): string {
  if (entry.secret) return '机密内容不参与召回'
  if (stat?.total) {
    const counted = `${stat.total} 次（保留期内 ${stat.recent} 次）`
    return stat.lastRecalledAt
      ? `${counted}，最近 ${formatRelative(stat.lastRecalledAt, now)}`
      : counted
  }
  if (entry.boot) return '符合启动加载条件'
  return stat ? '尚未召回' : '–'
}
