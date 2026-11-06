import type { QueryClient } from '@tanstack/vue-query'

// 联系人改了之后要刷新的：联系人列表与详情、几个选联系人的下拉框、应用里按群换人格的群名、待确认内容、
// 会话列表与详情（名字、在那里记下的事实）、删掉的事实所在的记忆列表、已删除与变更记录，
// 以及概览里等确认的绑定和导航上待处理的条数。改名、标记、合并、删事实、确认或拒绝绑定之后都调用
export function refreshSubjectCaches(queryClient: QueryClient, spaceId: string) {
  return Promise.all(
    [
      'subject',
      'subjects',
      'conversations',
      'conversation',
      'merge-picker',
      'group-personas',
      'group-picker',
      'review',
      'memory-list',
      'memory-deleted',
      'activity',
      'overview',
      'inbox-counts',
    ].map((key) => queryClient.invalidateQueries({ queryKey: [key, spaceId] })),
  )
}
