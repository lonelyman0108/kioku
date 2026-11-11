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

// 进入带空间的地址时记下；由路由的 afterEach 调用。只记当前账号是成员的空间：
// 不是成员的地址（旧链接、被移出）不顶掉上一次的空间
export function rememberSpace(id: string): void {
  const me = queryClient.getQueryData<Me | null>(ME_KEY)
  if (!me || !pickSpace(me.spaces, id, null)) return
  if (lastSpaceId.value === id) return
  lastSpaceId.value = id
  try {
    sessionStorage.setItem(LAST_SPACE_KEY, id)
  } catch {
    // 存不下时只在内存里记
  }
}

// 退出登录、会话失效时清掉：同一个标签页里换人登录，不沿用上一个人的空间。
// 给了 id 时只在记住的正是它（离开或删掉了这个空间）时清掉
export function forgetSpace(id?: string): void {
  if (id !== undefined && lastSpaceId.value !== id) return
  lastSpaceId.value = null
  try {
    sessionStorage.removeItem(LAST_SPACE_KEY)
  } catch {
    // 存储不可用时内存里已经清掉
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
