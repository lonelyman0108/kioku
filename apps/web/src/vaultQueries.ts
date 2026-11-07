import type { ConsoleCredential, ConsoleCredentialList } from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

import { api } from './api/endpoints'
import { invalidateInboxCounts } from './inbox'
import { staleCredentialIds } from './vault'

// 缓存里这条凭据的 valueChangedAt：先看详情，再看凭据列表；都没有时为 undefined
function cachedValueChangedAt(queryClient: QueryClient, spaceId: string, id: string) {
  const detail = queryClient.getQueryData<ConsoleCredential>(['credential', spaceId, id])
  if (detail) return detail.valueChangedAt
  const list = queryClient.getQueryData<ConsoleCredentialList>(['credentials', spaceId])
  return list?.items.find((c) => c.id === id)?.valueChangedAt
}

// 条目列表的查询函数：查询键一律是 ['vault-items', spaceId, connectionId]，凭据页、详情、表单与去处共用。
// 列条目时服务端会核对条目的修改时间，变了就清掉「需要轮换」、版本号加一。只有可能改了的（staleCredentialIds：
// 修改时间和缓存里的 valueChangedAt 对不上，或者还没缓存）才让凭据列表、那几条的详情与待处理的条数失效：
// 几个面板、详情与表单一起读时，不至于每读一次就把凭据全部重读一遍。不会反过来让条目列表失效，不会循环
export async function fetchVaultItems(
  queryClient: QueryClient,
  spaceId: string,
  connectionId: string,
) {
  const list = await api.vaultItems(spaceId, connectionId)
  const stale = staleCredentialIds(list.items, (id) =>
    cachedValueChangedAt(queryClient, spaceId, id),
  )
  if (stale.length) {
    void queryClient.invalidateQueries({ queryKey: ['credentials', spaceId] })
    for (const id of stale) {
      void queryClient.invalidateQueries({ queryKey: ['credential', spaceId, id] })
    }
    void invalidateInboxCounts(queryClient, spaceId)
  }
  return list
}
