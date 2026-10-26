import { SENSITIVITIES, type MemoryView } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { useSession } from './useSession'

// 成员在管理界面里能对记忆做什么，规则与服务端的 consoleAccess 一致：
// owner 都能写；editor 最高到 private，应用层只能写自己是主人的应用；viewer 只读。
// 服务端仍会逐条校验，这里只决定显示哪些操作，免得点了才报没有权限
export function useMemoryPermissions(spaceId: Ref<string>) {
  const { me, space } = useSession()
  const apps = useQuery({
    queryKey: computed(() => ['apps', spaceId.value]),
    queryFn: () => api.apps(spaceId.value),
  })
  const role = computed(() => space.value?.role ?? 'viewer')
  const canWrite = computed(() => role.value !== 'viewer')
  const sensitivities = computed(() =>
    SENSITIVITIES.filter((s) => role.value === 'owner' || s !== 'secret'),
  )

  function canWriteUri(uri: string): boolean {
    if (!canWrite.value) return false
    if (role.value === 'owner') return true
    const slug = /^app:\/\/([^/]+)/.exec(uri)?.[1]
    if (!slug) return true
    return (
      apps.data.value?.some((a) => a.slug === slug && a.ownerAccountId === me.data.value?.id) ??
      false
    )
  }

  // 不能改时给出原因，显示在编辑器上方
  function readOnlyReason(memory: MemoryView): string | null {
    if (!canWrite.value) return '你在这个空间是 viewer，只能查看。'
    if (!canWriteUri(memory.uri)) {
      // editor 要知道应用是不是自己的，得先读到应用列表
      if (apps.isPending.value) return '正在确认这个应用是不是你的……'
      if (apps.isError.value)
        return '应用列表读取失败，暂时无法确认能不能修改应用层记忆，请刷新重试。'
      return '这是别人的应用的应用层记忆，只有应用主人和空间 owner 能修改。'
    }
    if (memory.sensitivity === 'secret' && role.value !== 'owner') {
      return 'secret 级记忆只有空间 owner 能修改。'
    }
    return null
  }

  return { role, canWrite, sensitivities, canWriteUri, readOnlyReason }
}
