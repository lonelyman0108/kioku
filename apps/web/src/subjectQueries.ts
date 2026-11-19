import type { QueryClient } from '@tanstack/vue-query'

// 联系人改了之后要刷新的：联系人列表与详情、合并选人下拉框、接入实例按群规则、待确认内容、
// 会话列表与详情、词条列表与目录、变更记录，以及概览里等确认的绑定和导航上待处理的条数
export function refreshSubjectCaches(
  queryClient: QueryClient,
  circleId: string,
  subjectId?: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['subjects', circleId] }),
    queryClient.invalidateQueries({
      queryKey: subjectId ? ['subject', circleId, subjectId] : ['subject', circleId],
    }),
    queryClient.invalidateQueries({ queryKey: ['conversations', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['conversation', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['merge-picker', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['client-group-rules', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['review', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['entries', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['entry-list', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['browse-entries', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['activity', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['overview', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['inbox-counts', circleId] }),
  ])
}
