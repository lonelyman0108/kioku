import type { Me } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { ref, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'
import { hasUnsavedChanges } from './unsavedChanges'
import { fetchMe, forgetSpace } from './useSession'
import { dropSpaceQueries, nextSpace, refreshSpaces } from '../spaces'

// 离开或删除空间之后：丢掉这个空间的查询，刷新空间与账号列表，会话只重取一次；记住的空间正是它时忘掉。
// 当前页面属于这个空间时去别的空间的概览，没有空间时回首页；这时未保存的改动随之作废，不再确认。
// 在别处（实例 › 空间）删掉别的空间时留在原页
export function useAfterSpaceGone() {
  const router = useRouter()
  const route = useRoute()
  return async (spaceId: string) => {
    dropSpaceQueries(queryClient, spaceId)
    forgetSpace(spaceId)
    const [me] = await Promise.all([
      queryClient.fetchQuery<Me | null>({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 0 }),
      refreshSpaces(queryClient, undefined, { me: false }),
    ])
    if (route.params.spaceId !== spaceId) return
    const next = nextSpace(me?.spaces ?? [], spaceId)
    hasUnsavedChanges.value = false
    await router.replace(next ? { name: 'overview', params: { spaceId: next } } : { name: 'home' })
  }
}

// 当前账号离开空间：确认弹窗的状态与执行。失败的原因（例如刚成了唯一的所有者）留在弹窗里
export function useLeaveSpace(spaceId: Ref<string>, accountId: Ref<string | undefined>) {
  const toast = useToast()
  const afterGone = useAfterSpaceGone()
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
    const space = spaceId.value
    try {
      await api.removeMember(space, id)
      open.value = false
      toast.add({ title: '已离开空间', color: 'success' })
      await afterGone(space)
    } catch (err) {
      error.value = err instanceof ApiError ? err.message : '离开失败'
    } finally {
      busy.value = false
    }
  }
  return { open, busy, error, start, confirm }
}
