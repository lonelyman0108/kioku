import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'

// 左栏小节后面的条数：按「组:小节」给，没有的不显示。和小节里的列表共用缓存
export function useSectionCounts(circleId: Ref<string | null>) {
  const members = useQuery({
    queryKey: computed(() => ['members', circleId.value]),
    queryFn: () => api.members(circleId.value!),
    enabled: computed(() => Boolean(circleId.value)),
  })
  return computed<Record<string, number | undefined>>(() => ({
    'circle:members': members.data.value?.length,
  }))
}
