import type { CreatedSpace } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { queryClient } from '../query'
import { refreshSpaces } from '../spaces'

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
    await refreshSpaces(queryClient)
    toast.add({ title: `已新建空间「${space.name}」`, color: 'success' })
    await router.push({ name: 'overview', params: { spaceId: space.id } })
  }
  return { canCreate, open, created }
}
