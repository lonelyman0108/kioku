import type { AccessContext, KeyInfo } from '@kioku/contracts'
import { useQueries } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { KEY_MATRIX_STALE_TIME, keyMatrixKey } from '../appQueries'
import type { AccessRow } from '../components/strata/strata'

// 一批 Key 的权限范围，每根岩芯一个：和权限范围矩阵同一份缓存，数据都来自接口。
// 只传还有效的 Key，作废的接口返回 404
export function useKeyMatrices(
  spaceId: Ref<string>,
  keys: Ref<readonly { appId: string; key: Pick<KeyInfo, 'id' | 'effectiveScopes'> }[]>,
) {
  const results = useQueries({
    queries: computed(() =>
      keys.value.map(({ appId, key }) => ({
        queryKey: keyMatrixKey(spaceId.value, appId, key),
        queryFn: ({ queryKey: [, sid, aid, kid] }: { queryKey: readonly unknown[] }) =>
          api.keyMatrix(sid as string, aid as string, kid as string),
        staleTime: KEY_MATRIX_STALE_TIME,
      })),
    ),
  })
  const resultOf = (keyId: string) => {
    const index = keys.value.findIndex(({ key }) => key.id === keyId)
    return index < 0 ? undefined : results.value[index]
  }
  // 还没读到或者读取失败时是 null，岩芯不能画成没有权限
  function rowsOf(keyId: string, context: AccessContext = 'none'): readonly AccessRow[] | null {
    return resultOf(keyId)?.data?.contexts.find((c) => c.context === context)?.rows ?? null
  }
  // 这根岩芯读取失败时的文字
  function failureOf(keyId: string): string | null {
    const result = resultOf(keyId)
    return result?.isError ? readFailure(result.error) : null
  }
  return { rowsOf, failureOf }
}
