import type { CreatedSpace } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, inject, ref, type InjectionKey, type Ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { queryClient } from '../query'
import { refreshSpaces, SPACE_LIMIT_KEY, spaceLimitNote } from '../spaces'

export type NewSpaceEntry = ReturnType<typeof useCreateSpace>

// 新建、导入空间的入口与弹窗只在外壳里有一份，由外壳 provide；首页没有空间时经 useNewSpaceEntry 打开同一个弹窗。
// 不在外壳里（组件测试、以后别的路由）时为 null，调用方不显示按钮
export const NEW_SPACE: InjectionKey<NewSpaceEntry> = Symbol('new-space')

export function useNewSpaceEntry(): NewSpaceEntry | null {
  return inject(NEW_SPACE, null)
}

// 空间数量上限与当前账号的名额。blocked 是名额用完时的说明，入口不可用时写在旁边
export function useSpaceLimit(enabled?: Ref<boolean>) {
  const limit = useQuery({
    queryKey: SPACE_LIMIT_KEY,
    queryFn: api.spaceLimit,
    ...(enabled ? { enabled } : {}),
  })
  const blocked = computed(() => spaceLimitNote(limit.data.value))
  return { limit, blocked }
}

// 空间切换器与首页的「新建空间」「导入空间」：登录的账号都有，名额用完时入口还在、不可用，旁边写原因（blocked）。
// 建好后刷新会话里的空间列表与名额，进新空间的概览；导入的弹窗自己刷新与跳转
export function useCreateSpace(signedIn: Ref<boolean>) {
  const router = useRouter()
  const toast = useToast()
  const { blocked } = useSpaceLimit(signedIn)
  const open = ref(false)
  const importing = ref(false)
  async function created(space: CreatedSpace) {
    open.value = false
    await refreshSpaces(queryClient, undefined, { accounts: true })
    toast.add({ title: `已新建空间「${space.name}」`, color: 'success' })
    await router.push({ name: 'overview', params: { spaceId: space.id } })
  }
  return { blocked, open, importing, created }
}
