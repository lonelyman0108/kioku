import type { AccessContext } from '@kioku/contracts'
import { useQueries } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import type { AccessRow } from '../components/strata/strata'

// 一批 Key 的权限范围，每根岩芯一个：和权限范围矩阵同一份缓存，数据都来自接口。
// 只传还有效的 Key，作废的接口返回 404
export function useKeyMatrices(
  spaceId: Ref<string>,
  keys: Ref<readonly { appId: string; keyId: string }[]>,
) {
  const results = useQueries({
    queries: computed(() =>
      keys.value.map(({ appId, keyId }) => ({
        queryKey: ['key-matrix', spaceId.value, appId, keyId] as const,
        queryFn: ({ queryKey: [, sid, aid, kid] }: { queryKey: readonly string[] }) =>
          api.keyMatrix(sid!, aid!, kid!),
      })),
    ),
  })
  // 还没读到或者读取失败时是 null，岩芯不能画成没有权限
  function rowsOf(keyId: string, context: AccessContext = 'none'): readonly AccessRow[] | null {
    const index = keys.value.findIndex((key) => key.keyId === keyId)
    const matrix = index < 0 ? undefined : results.value[index]?.data
    return matrix?.contexts.find((c) => c.context === context)?.rows ?? null
  }
  return { rowsOf }
}
