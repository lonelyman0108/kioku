import type { QueryClient } from '@tanstack/vue-query'

import { invalidateActivity } from './activity'

// 联系人改了之后要刷新的：联系人列表与详情、合并选人下拉框、客户端按群规则、待确认内容、
// 会话列表与详情、记忆列表与目录、双链、变更记录，以及概览和导航上的待处理条数
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
    queryClient.invalidateQueries({ queryKey: ['entry', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['entry-list', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['entry-browse', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['entry-links', circleId] }),
    invalidateActivity(queryClient, circleId),
    queryClient.invalidateQueries({ queryKey: ['overview', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['inbox-counts', circleId] }),
  ])
}
