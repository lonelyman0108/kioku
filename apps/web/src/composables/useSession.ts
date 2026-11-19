import type { CircleSummary, Me } from '@kioku/contracts'
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

// 最近访问的记忆圈：地址里不带记忆圈的页面（个人、实例设置）沿用它，不退回第一个。
// 刷新页面也记得，存在 sessionStorage；隐私模式或禁用存储时读写会抛错，只在内存里记
const LAST_CIRCLE_KEY = 'kioku:lastCircle'
function readLastCircle(): string | null {
  try {
    return sessionStorage.getItem(LAST_CIRCLE_KEY)
  } catch {
    return null
  }
}
const lastCircleId = ref<string | null>(readLastCircle())

// 进入带记忆圈的地址时记下；由路由的 afterEach 调用。只记当前账号是成员的记忆圈：
// 不是成员的地址（旧链接、被移出）不顶掉上一次的记忆圈
export function rememberCircle(id: string): void {
  const me = queryClient.getQueryData<Me | null>(ME_KEY)
  if (!me || !me.circles.some((c) => c.id === id)) return
  if (lastCircleId.value === id) return
  lastCircleId.value = id
  try {
    sessionStorage.setItem(LAST_CIRCLE_KEY, id)
  } catch {
    // 存不下时只在内存里记
  }
}

// 退出登录、会话失效时清掉：同一个标签页里换人登录，不沿用上一个人的记忆圈。
// 给了 id 时只在记住的正是它（离开或删掉了这个记忆圈）时清掉
export function forgetCircle(id?: string): void {
  if (id !== undefined && lastCircleId.value !== id) return
  lastCircleId.value = null
  try {
    sessionStorage.removeItem(LAST_CIRCLE_KEY)
  } catch {
    // 存储不可用时内存里已经清掉
  }
}

// 当前记忆圈：地址里指定了记忆圈时只认那个记忆圈，不是它的成员就是 null（不借用别的记忆圈的角色）；
// 没指定时取最近访问的记忆圈，它已不在成员的记忆圈里时优先落回个人记忆圈，否则取第一个
export function pickCircle(
  circles: readonly CircleSummary[],
  routeCircleId: unknown,
  lastId: string | null,
  personalCircleId?: string,
): CircleSummary | null {
  if (typeof routeCircleId === 'string') return circles.find((c) => c.id === routeCircleId) ?? null
  return (
    circles.find((c) => c.id === lastId) ??
    (personalCircleId ? circles.find((c) => c.id === personalCircleId) : undefined) ??
    circles[0] ??
    null
  )
}

export function useSession() {
  const me = useQuery({ queryKey: ME_KEY, queryFn: fetchMe })
  const route = useRoute()
  const circle = computed(() =>
    pickCircle(
      me.data.value?.circles ?? [],
      route.params.circleId,
      lastCircleId.value,
      me.data.value?.personalCircleId,
    ),
  )
  return { me, circle }
}
