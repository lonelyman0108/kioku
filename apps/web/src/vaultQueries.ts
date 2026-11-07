import type { QueryClient } from '@tanstack/vue-query'

import { api } from './api/endpoints'
import { invalidateInboxCounts } from './inbox'

// 和密码库同步过之后要刷新的：列条目、重新检查时服务端会核对条目的修改时间，变了就清掉「需要轮换」、
// 版本号加一。凭据列表、详情与待处理的条数跟着重读，否则下一次修改带着旧版本号 409
export function refreshAfterVaultSync(queryClient: QueryClient, spaceId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['credentials', spaceId] }),
    queryClient.invalidateQueries({ queryKey: ['credential', spaceId] }),
    invalidateInboxCounts(queryClient, spaceId),
  ])
}

// 条目列表的查询函数：查询键一律是 ['vault-items', spaceId, connectionId]，凭据页、详情、表单与去处共用。
// 读到之后按 refreshAfterVaultSync 刷新（不等它）：不会反过来让条目列表失效，不会循环
export async function fetchVaultItems(
  queryClient: QueryClient,
  spaceId: string,
  connectionId: string,
) {
  const list = await api.vaultItems(spaceId, connectionId)
  void refreshAfterVaultSync(queryClient, spaceId)
  return list
}
