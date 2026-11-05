import { useToast } from '@nuxt/ui/composables'
import type { ConsoleMemoryView } from '@kioku/contracts'
import { useQueryClient, type QueryClient } from '@tanstack/vue-query'
import { ref, type Ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'

// 疑似明文的提示处理之后要刷新的：条数、列表、概览、变更记录，这条记忆的历史和详情
export function refreshAfterPlaintext(
  queryClient: QueryClient,
  spaceId: string,
  memory?: ConsoleMemoryView,
) {
  for (const key of ['inbox-counts', 'memory-list', 'overview', 'activity']) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId] })
  }
  if (!memory) return
  queryClient.setQueryData(['memory', spaceId, memory.uri], memory)
  void queryClient.invalidateQueries({ queryKey: ['memory-history', spaceId, memory.id] })
}

// 忽略和撤销忽略：带着看到提示时的版本，期间正文被改过就不替新的正文做决定，由服务端返回冲突
export function usePlaintextActions(spaceId: Ref<string>) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const busy = ref<string | null>(null)

  async function run(
    call: typeof api.ignorePlaintext,
    done: string,
    target: { id: string; version: number },
  ): Promise<ConsoleMemoryView | null> {
    if (busy.value) return null
    const sid = spaceId.value
    busy.value = target.id
    try {
      const memory = await call(sid, { memoryId: target.id, expectedVersion: target.version })
      toast.add({ title: done, color: 'success' })
      refreshAfterPlaintext(queryClient, sid, memory)
      return memory
    } catch (err) {
      toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
      // 列表里的版本已经旧了：重新读取，看过新的正文再决定
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, sid)
      }
      return null
    } finally {
      busy.value = null
    }
  }

  return {
    busy,
    ignore: (target: { id: string; version: number }) =>
      run(api.ignorePlaintext, '已忽略，正文修改后会重新提示', target),
    unignore: (target: { id: string; version: number }) =>
      run(api.unignorePlaintext, '已撤销忽略', target),
  }
}
