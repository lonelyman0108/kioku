import type { Me, SpaceSummary } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
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

// 最近访问的空间：地址里不带空间的页面（个人、实例设置）沿用它，不退回第一个空间。
// 刷新页面也记得，存在 sessionStorage；隐私模式或禁用存储时读写会抛错，只在内存里记
const LAST_SPACE_KEY = 'kioku:last-space'
function readLastSpace(): string | null {
  try {
    return sessionStorage.getItem(LAST_SPACE_KEY)
  } catch {
    return null
  }
}
const lastSpaceId = ref<string | null>(readLastSpace())

// 进入带空间的地址时记下；由路由的 afterEach 调用
export function rememberSpace(id: string): void {
  if (lastSpaceId.value === id) return
  lastSpaceId.value = id
  try {
    sessionStorage.setItem(LAST_SPACE_KEY, id)
  } catch {
    // 存不下时只在内存里记
  }
}

// 当前空间：地址里指定了空间时只认那个空间，不是它的成员就是 null（不借用别的空间的角色）；
// 没指定时取最近访问的空间，它已不在成员的空间里（被移出、换了账号）时取第一个
export function pickSpace(
  spaces: readonly SpaceSummary[],
  routeSpaceId: unknown,
  lastId: string | null,
): SpaceSummary | null {
  if (typeof routeSpaceId === 'string') return spaces.find((s) => s.id === routeSpaceId) ?? null
  return spaces.find((s) => s.id === lastId) ?? spaces[0] ?? null
}

export function useSession() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe })
  const route = useRoute()
  const space = computed(() =>
    pickSpace(me.data.value?.spaces ?? [], route.params.spaceId, lastSpaceId.value),
  )
  return { me, space }
}
