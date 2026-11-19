import type { CreatedCircle } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery } from '@tanstack/vue-query'
import { computed, inject, ref, type InjectionKey, type Ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { queryClient } from '../query'
import { CIRCLE_LIMIT_KEY, circleLimitNote, refreshCircles } from '../spaces'

export type NewCircleEntry = ReturnType<typeof useCreateCircle>

// 新建共享圈与导入记忆圈的入口与弹窗只在外壳里有一份，由外壳 provide；首页没有记忆圈时经 useNewCircleEntry 打开同一个弹窗。
// 不在外壳里（组件测试、以后别的路由）时为 null，调用方不显示按钮
export const NEW_CIRCLE: InjectionKey<NewCircleEntry> = Symbol('new-circle')

export function useNewCircleEntry(): NewCircleEntry | null {
  return inject(NEW_CIRCLE, null)
}

// 共享记忆圈数量上限与当前账号的名额。blocked 是名额用完时的说明，新建共享圈不可用时写在旁边
export function useCircleLimit(enabled?: Ref<boolean>) {
  const limit = useQuery({
    queryKey: CIRCLE_LIMIT_KEY,
    queryFn: api.circleLimit,
    ...(enabled ? { enabled } : {}),
  })
  const blocked = computed(() => circleLimitNote(limit.data.value))
  return { limit, blocked }
}

// 切换器与首页的「新建共享圈」「导入记忆圈」：登录的账号都有，名额用完时「新建共享圈」不可用、旁边写原因（blocked）。
// 建好后刷新会话里的记忆圈列表与名额，进新记忆圈的概览；导入的弹窗自己刷新与跳转
export function useCreateCircle(signedIn: Ref<boolean>) {
  const router = useRouter()
  const toast = useToast()
  const { blocked } = useCircleLimit(signedIn)
  const open = ref(false)
  const importing = ref(false)
  async function created(circle: CreatedCircle) {
    open.value = false
    await refreshCircles(queryClient, undefined, { accounts: true })
    toast.add({ title: `已新建共享圈「${circle.name}」`, color: 'success' })
    await router.push({ name: 'overview', params: { circleId: circle.id } })
  }
  return { blocked, open, importing, created }
}
