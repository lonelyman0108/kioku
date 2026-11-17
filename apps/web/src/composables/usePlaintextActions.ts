import { useToast } from '@nuxt/ui/composables'
import type { ConsoleMemoryView, ProtectTarget, RedactMode } from '@kioku/contracts'
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
  // activity-event：变更记录详情里的前后快照可能带着刚转存走的值
  for (const key of ['inbox-counts', 'memory-list', 'overview', 'activity', 'activity-event']) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId] })
  }
  if (!memory) return
  queryClient.setQueryData(['memory', spaceId, memory.uri], memory)
  void queryClient.invalidateQueries({ queryKey: ['memory-history', spaceId, memory.id] })
}

// 忽略、撤销忽略、保护（移入本人私密 / 设为机密）与抹除敏感段：带着看到提示时的版本，由服务端核对并发
export function usePlaintextActions(spaceId: Ref<string>) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const busy = ref<string | null>(null)

  async function run(
    call: (
      sid: string,
      body: { memoryId: string; expectedVersion: number },
    ) => Promise<ConsoleMemoryView>,
    done: string,
    target: { id: string; version: number },
    refreshTree = false,
  ): Promise<ConsoleMemoryView | null> {
    if (busy.value) return null
    const sid = spaceId.value
    busy.value = target.id
    try {
      const memory = await call(sid, { memoryId: target.id, expectedVersion: target.version })
      toast.add({ title: done, color: 'success' })
      refreshAfterPlaintext(queryClient, sid, memory)
      if (refreshTree) {
        void queryClient.invalidateQueries({ queryKey: ['memory-children', sid] })
      }
      return memory
    } catch (err) {
      toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
      // 列表或详情里的版本已经旧了：重新读取，看过新的正文再决定
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, sid)
        void queryClient.invalidateQueries({ queryKey: ['memory', sid] })
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
    protect: (
      target: { id: string; version: number; layer?: string },
      protectTarget: ProtectTarget,
    ) =>
      run(
        (sid, body) => api.protectMemory(sid, { ...body, target: protectTarget }),
        protectTarget === 'secret'
          ? '已设为机密，正文已加密存储'
          : target.layer && target.layer !== 'user'
            ? '已移入本人私密，原文已保留'
            : '已设为本人私密，原文已保留',
        target,
        protectTarget === 'user_private' && target.layer !== 'user',
      ),
    redact: (target: { id: string; version: number }, mode: RedactMode = 'stars') =>
      run((sid, body) => api.redactMemory(sid, { ...body, mode }), '已抹除敏感段', target),
  }
}
