import type { Me } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { nextTick, ref, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'
import { dropCircleQueries, nextCircle, refreshCircles, stopCircleQueries } from '../spaces'
import { hasUnsavedChanges } from './unsavedChanges'
import { fetchMe, forgetCircle } from './useSession'

// 离开或删除记忆圈之后，按这个顺序：
// 1. 停下这个记忆圈正在取的查询，记住的记忆圈正是它时忘掉；
// 2. 当前页面属于这个记忆圈时先离开：优先去个人记忆圈（否则去别的记忆圈）的概览，没有记忆圈时回首页；
//    未保存的改动随之作废，不再确认。在别处（实例 › 记忆圈）删掉别的记忆圈时留在原页；
// 3. 会话只重取一次，记忆圈与账号列表一起刷新；
// 4. 等页面换完，丢掉这个记忆圈的查询（只丢没有观察者的）。先丢再跳的话，还挂着的页面会为删掉的键重新请求
export function useAfterCircleGone() {
  const router = useRouter()
  const route = useRoute()
  return async (circleId: string) => {
    await stopCircleQueries(queryClient, circleId)
    forgetCircle(circleId)
    if (route.params.circleId === circleId) {
      const cached = queryClient.getQueryData<Me | null>(ME_KEY)
      const next = nextCircle(cached?.circles ?? [], circleId, cached?.personalCircleId)
      hasUnsavedChanges.value = false
      await router.replace(
        next ? { name: 'overview', params: { circleId: next } } : { name: 'home' },
      )
    }
    await Promise.all([
      queryClient.fetchQuery<Me | null>({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 }),
      refreshCircles(queryClient, undefined, { me: false, accounts: true }),
    ])
    await nextTick()
    dropCircleQueries(queryClient, circleId)
  }
}

// 当前账号离开共享记忆圈：确认弹窗的状态与执行。失败的原因（例如刚成了唯一的所有者）留在弹窗里
export function useLeaveCircle(circleId: Ref<string>, accountId: Ref<string | undefined>) {
  const toast = useToast()
  const afterGone = useAfterCircleGone()
  const open = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)
  function start() {
    error.value = null
    open.value = true
  }
  async function confirm() {
    const id = accountId.value
    if (!id || busy.value) return
    busy.value = true
    error.value = null
    const circle = circleId.value
    try {
      await api.removeMember(circle, id)
      open.value = false
      toast.add({ title: '已离开记忆圈', color: 'success' })
      await afterGone(circle)
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : '离开失败'
    } finally {
      busy.value = false
    }
  }
  return { open, busy, error, start, confirm }
}
