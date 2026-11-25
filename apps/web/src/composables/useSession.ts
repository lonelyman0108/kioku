import type { Me } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'

export { ME_KEY }

// 未登录时返回 null 而不是抛错，页面与路由守卫都按 null 判断
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
  return { me }
}
