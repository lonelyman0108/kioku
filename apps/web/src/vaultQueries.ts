import type { ConsoleCredential, ConsoleCredentialList } from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

import { api } from './api/endpoints'
import { invalidateInboxCounts } from './inbox'
import { staleCredentialIds } from './vault'

// 缓存里这条凭据的 valueChangedAt：先看详情，再看凭据列表；都没有时为 undefined
function cachedValueChangedAt(queryClient: QueryClient, circleId: string, id: string) {
  const detail = queryClient.getQueryData<ConsoleCredential>(['credential', circleId, id])
  if (detail) return detail.valueChangedAt
  const list = queryClient.getQueryData<ConsoleCredentialList>(['credentials', circleId])
  return list?.items.find((c) => c.id === id)?.valueChangedAt
}

// 条目列表的查询函数：查询键一律是 ['vault-items', circleId, connectionId]，凭据页、详情、表单与去处共用。
// 列条目时服务端会核对条目的修改时间，变了就清掉「需要轮换」、版本号加一。只有可能改了的（staleCredentialIds）
// 才让凭据列表、那几条的详情与待处理的条数失效；不会反过来让条目列表失效，不会循环
export async function fetchVaultItems(
  queryClient: QueryClient,
  circleId: string,
  connectionId: string,
) {
  const list = await api.vaultItems(circleId, connectionId)
  const stale = staleCredentialIds(list.items, (id) =>
    cachedValueChangedAt(queryClient, circleId, id),
  )
  if (stale.length) {
    void queryClient.invalidateQueries({ queryKey: ['credentials', circleId] })
    for (const id of stale) {
      void queryClient.invalidateQueries({ queryKey: ['credential', circleId, id] })
    }
    void invalidateInboxCounts(queryClient, circleId)
  }
  return list
}
