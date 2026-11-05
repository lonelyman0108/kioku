import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { inboxCountsKey } from '../inbox'

// 待处理各类的条数：导航角标和待处理页共用一份缓存。空间未知时不查
export function useInboxCounts(spaceId: Ref<string | null>) {
  return useQuery({
    queryKey: computed(() => inboxCountsKey(spaceId.value ?? '')),
    queryFn: ({ queryKey: [, id] }) => api.inboxCounts(id),
    enabled: computed(() => Boolean(spaceId.value)),
    staleTime: 60_000,
  })
}
