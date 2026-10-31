import type { InboxCounts, MemberRole } from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

// 待处理的四类：分类的名字、条数，地址里选的是哪一类

export const INBOX_TABS = ['binding', 'review', 'dream', 'plaintext'] as const
export type InboxTab = (typeof INBOX_TABS)[number]

export const inboxTabLabels: Record<InboxTab, string> = {
  binding: '账号绑定',
  review: '待确认内容',
  dream: '整理建议',
  plaintext: '疑似明文凭据',
}

export const inboxTabCount = (counts: InboxCounts, tab: InboxTab): number =>
  ({
    binding: counts.bindings,
    review: counts.review,
    dream: counts.dreamSuggestions,
    plaintext: counts.plaintext,
  })[tab]

// 红色角标和「N 项待处理」的数字：当前账号动得了手的。查看者只能拒绝等本人确认的账号绑定，
// 别的几类动不了，算进去这个数字永远消不掉
export const actionableInboxCount = (counts: InboxCounts, role: MemberRole): number =>
  role === 'viewer' ? counts.bindings : counts.total

const isInboxTab = (value: unknown): value is InboxTab =>
  (INBOX_TABS as readonly unknown[]).includes(value)

// 看的是哪一类：地址里写了就看那一类。没写时看第一个有内容的，都没有内容时看待确认内容；
// 条数还没读到时是 null，读到再决定，不先闪一下别的分类。读取失败时不再等
export function resolveInboxTab(
  tab: unknown,
  counts: InboxCounts | undefined,
  failed: boolean,
): InboxTab | null {
  if (isInboxTab(tab)) return tab
  if (!counts) return failed ? 'review' : null
  return INBOX_TABS.find((t) => inboxTabCount(counts, t) > 0) ?? 'review'
}

// 旧地址 review 的两个分页对应到这里；旧地址别的参数不再有意义
export const legacyReviewTab = (tab: unknown): InboxTab => (tab === 'dream' ? 'dream' : 'review')

// 条数的缓存键。这个接口每次跑正则（两万条约 110 毫秒），所以有 staleTime，不跟着每个页面重取，
// 处理完待办之后才让它失效
export const inboxCountsKey = (spaceId: string) => ['inbox-counts', spaceId] as const

export const invalidateInboxCounts = (queryClient: QueryClient, spaceId: string) =>
  queryClient.invalidateQueries({ queryKey: inboxCountsKey(spaceId) })

// 手动刷新：四类的列表和条数一起重取
export function refreshInbox(queryClient: QueryClient, spaceId: string) {
  return Promise.all(
    ['inbox-counts', 'overview', 'review', 'dream-suggestions', 'dream-runs', 'memory-list'].map(
      (key) => queryClient.invalidateQueries({ queryKey: [key, spaceId] }),
    ),
  )
}
