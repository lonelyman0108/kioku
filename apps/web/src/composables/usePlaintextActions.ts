import { useToast } from '@nuxt/ui/composables'
import type { ConsoleEntryView, ProtectTarget, RedactMode } from '@kioku/contracts'
import { useQueryClient, type QueryClient } from '@tanstack/vue-query'
import { ref, type Ref } from 'vue'

import { invalidateActivity } from '../activity'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { invalidateInboxCounts } from '../inbox'

// 疑似敏感内容提示处理之后要刷新的：条数、列表、浏览目录、双链、概览、变更记录，这条记忆的历史和详情
export function refreshAfterPlaintext(
  queryClient: QueryClient,
  circleId: string,
  entry?: ConsoleEntryView,
) {
  for (const key of ['inbox-counts', 'entry-list', 'entry-browse', 'entry-links', 'overview']) {
    void queryClient.invalidateQueries({ queryKey: [key, circleId] })
  }
  void invalidateActivity(queryClient, circleId)
  if (!entry) return
  if (entry.circleId !== circleId) {
    for (const key of ['inbox-counts', 'entry-list', 'entry-browse', 'entry-links', 'overview']) {
      void queryClient.invalidateQueries({ queryKey: [key, entry.circleId] })
    }
    void invalidateActivity(queryClient, entry.circleId)
    void queryClient.invalidateQueries({ queryKey: ['entry', circleId] })
  }
  if (!entry.contentHidden) {
    queryClient.setQueryData(['entry', entry.circleId, entry.shortId], entry)
  } else {
    void queryClient.invalidateQueries({ queryKey: ['entry', entry.circleId, entry.shortId] })
  }
  void queryClient.invalidateQueries({ queryKey: ['entry-history', entry.circleId, entry.id] })
  void queryClient.invalidateQueries({ queryKey: ['entry-history', circleId, entry.id] })
  void invalidateInboxCounts(queryClient, circleId)
}

// 忽略、撤销忽略、保护（移入个人圈私密 / 设为机密）与抹除敏感段：带着看到提示时的版本，由服务端核对并发
export function usePlaintextActions(circleId: Ref<string>) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const busy = ref<string | null>(null)

  async function run(
    call: (
      cid: string,
      body: { entryId: string; expectedVersion: number },
    ) => Promise<ConsoleEntryView>,
    done: string,
    target: { id: string; version: number },
  ): Promise<ConsoleEntryView | null> {
    if (busy.value) return null
    const cid = circleId.value
    busy.value = target.id
    try {
      const entry = await call(cid, { entryId: target.id, expectedVersion: target.version })
      toast.add({ title: done, color: 'success' })
      refreshAfterPlaintext(queryClient, cid, entry)
      return entry
    } catch (err) {
      toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
      // 列表或详情里的版本已经旧了：重新读取，看过新的正文再决定
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
        refreshAfterPlaintext(queryClient, cid)
        void queryClient.invalidateQueries({ queryKey: ['entry', cid] })
      }
      return null
    } finally {
      busy.value = null
    }
  }

  return {
    busy,
    ignore: (target: { id: string; version: number }, variantId?: string) =>
      run(
        (cid, body) => api.ignorePlaintext(cid, variantId ? { ...body, variantId } : body),
        '已忽略，正文修改后会重新提示',
        target,
      ),
    unignore: (target: { id: string; version: number }, variantId?: string) =>
      run(
        (cid, body) => api.unignorePlaintext(cid, variantId ? { ...body, variantId } : body),
        '已撤销忽略',
        target,
      ),
    protect: (
      target: { id: string; version: number; inPersonal?: boolean },
      protectTarget: ProtectTarget,
    ) =>
      run(
        (cid, body) => api.protectEntry(cid, { ...body, target: protectTarget }),
        protectTarget === 'secret'
          ? '已设为机密，正文已加密存储'
          : target.inPersonal
            ? '已设为私密，原文已保留'
            : '已移入个人圈私密，原文已保留',
        target,
      ),
    redact: (
      target: { id: string; version: number },
      mode: RedactMode = 'stars',
      variantId?: string,
    ) =>
      run(
        (cid, body) => api.redactEntry(cid, { ...body, mode, ...(variantId ? { variantId } : {}) }),
        '已抹除敏感段',
        target,
      ),
    moveToPersonalAndProtect: async (target: {
      id: string
      version: number
      personalCircleId: string
    }): Promise<ConsoleEntryView | null> => {
      if (busy.value) return null
      const cid = circleId.value
      busy.value = target.id
      try {
        let next = await api.transferEntry(cid, {
          entryId: target.id,
          toCircleId: target.personalCircleId,
          expectedVersion: target.version,
        })
        if (next.sensitivity !== 'private') {
          next = await api.protectEntry(target.personalCircleId, {
            entryId: next.id,
            expectedVersion: next.version,
            target: 'personal_private',
          })
        }
        toast.add({ title: '已移入个人圈私密，原文已保留', color: 'success' })
        refreshAfterPlaintext(queryClient, cid, next)
        return next
      } catch (err) {
        toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
          refreshAfterPlaintext(queryClient, cid)
          void queryClient.invalidateQueries({ queryKey: ['entry', cid] })
        }
        return null
      } finally {
        busy.value = null
      }
    },
  }
}
