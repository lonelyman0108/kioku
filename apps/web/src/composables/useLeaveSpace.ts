import type { Me } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, queryClient } from '../query'
import { hasUnsavedChanges } from './unsavedChanges'
import { fetchMe } from './useSession'
import { nextSpace, refreshSpaces } from '../spaces'

// 离开或删除空间之后：刷新会话里的空间列表，去别的空间的概览，没有空间时回首页。
// 当前页面属于已经不在的空间，未保存的改动随之作废，不再确认
export function useAfterSpaceGone() {
  const router = useRouter()
  return async (spaceId: string) => {
    await refreshSpaces(queryClient)
    const me = await queryClient.fetchQuery<Me | null>({
      queryKey: ME_KEY,
      queryFn: fetchMe,
      staleTime: 0,
    })
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
