import type { Me } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'

export { ME_KEY }

// 未登录时返回 null 而不是抛错，页面与守卫都按 null 判断
export async function fetchMe(): Promise<Me | null> {
  try {
    return await api.me()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

export function loadMe(): Promise<Me | null> {
  return queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: fetchMe })
}

export function useSession() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe })
  const route = useRoute()
  // 路由里指定了空间时只认那个空间，不是它的成员就是 null（不借用别的空间的角色）；没指定时取第一个
  const space = computed(() => {
    const spaces = me.data.value?.spaces ?? []
    const id = route.params.spaceId
    if (typeof id === 'string') return spaces.find((s) => s.id === id) ?? null
    return spaces[0] ?? null
  })
  return { me, space }
}
