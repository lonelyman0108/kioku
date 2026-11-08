import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'

// 左栏小节后面的条数：按「组:小节」给，没有的不显示。和小节里的列表共用缓存
export function useSectionCounts(spaceId: Ref<string | null>) {
  const members = useQuery({
    queryKey: computed(() => ['members', spaceId.value]),
    queryFn: () => api.members(spaceId.value!),
    enabled: computed(() => Boolean(spaceId.value)),
  })
  return computed<Record<string, number | undefined>>(() => ({
    'space:members': members.data.value?.length,
  }))
}
