import type { QueryClient } from '@tanstack/vue-query'

// 应用的改动会影响别处的缓存：应用列表、Key 与权限矩阵（按应用配置、默认人格与主人算）、
// 人格详情（列出以它为默认人格的应用）。新建、修改、转移应用之后都调用
export function refreshAppCaches(queryClient: QueryClient, spaceId: string, appId?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['apps', spaceId] }),
    queryClient.invalidateQueries({ queryKey: ['persona', spaceId] }),
    ...(appId
      ? [
          queryClient.invalidateQueries({ queryKey: ['keys', spaceId, appId] }),
          queryClient.invalidateQueries({ queryKey: ['key-matrix', spaceId, appId] }),
        ]
      : []),
  ])
}

// 删掉的应用：它的 Key 与权限矩阵不再请求（请求只会得到 404），直接去掉缓存，再刷新列表与人格详情
export function forgetApp(queryClient: QueryClient, spaceId: string, appId: string) {
  queryClient.removeQueries({ queryKey: ['keys', spaceId, appId] })
  queryClient.removeQueries({ queryKey: ['key-matrix', spaceId, appId] })
  return refreshAppCaches(queryClient, spaceId)
}
