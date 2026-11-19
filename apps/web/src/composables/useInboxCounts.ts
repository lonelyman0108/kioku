import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { inboxCountsKey } from '../inbox'

// 待处理各类的条数：导航角标和待处理页共用一份缓存。记忆圈未知时不查
export function useInboxCounts(circleId: Ref<string | null>) {
  return useQuery({
    queryKey: computed(() => inboxCountsKey(circleId.value ?? '')),
    queryFn: ({ queryKey: [, id] }) => api.inboxCounts(id),
    enabled: computed(() => Boolean(circleId.value)),
    staleTime: 60_000,
  })
}
