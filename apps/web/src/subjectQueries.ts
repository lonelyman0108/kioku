import type { QueryClient } from '@tanstack/vue-query'

// 对象改了之后要刷新的：对象页与几个选对象的下拉框、应用里按群换人格的群名、待审、
// 删掉的事实所在的记忆列表、已删除与活动，以及概览里等确认的绑定和导航上待处理的条数。
// 改名、标记、合并、删事实、确认或拒绝绑定之后都调用
export function refreshSubjectCaches(queryClient: QueryClient, spaceId: string) {
  return Promise.all(
    [
      'subject',
      'subjects',
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
