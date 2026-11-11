import type { CreatedSpace } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, inject, ref, type InjectionKey, type Ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { queryClient } from '../query'
import { refreshSpaces } from '../spaces'

export type NewSpaceEntry = ReturnType<typeof useCreateSpace>

// 新建空间的入口与弹窗只在外壳里有一份，由外壳 provide；首页没有空间时经 useNewSpaceEntry 打开同一个弹窗。
// 不在外壳里（组件测试、以后别的路由）时为 null，调用方不显示按钮
export const NEW_SPACE: InjectionKey<NewSpaceEntry> = Symbol('new-space')

export function useNewSpaceEntry(): NewSpaceEntry | null {
  return inject(NEW_SPACE, null)
}

// 空间切换器与首页的「新建空间」：实例管理员，或实例允许成员自建空间时才给（服务端的 canCreate）。
// 建好后刷新会话里的空间列表，进新空间的概览
export function useCreateSpace(signedIn: Ref<boolean>) {
  const router = useRouter()
  const toast = useToast()
  const policy = useQuery({
    queryKey: ['space-creation'],
    queryFn: api.spaceCreation,
    enabled: signedIn,
  })
  const canCreate = computed(() => policy.data.value?.canCreate ?? false)
  const open = ref(false)
  async function created(space: CreatedSpace) {
    open.value = false
    await refreshSpaces(queryClient, undefined, { accounts: true })
    toast.add({ title: `已新建空间「${space.name}」`, color: 'success' })
    await router.push({ name: 'overview', params: { spaceId: space.id } })
  }
  return { canCreate, open, created }
}
