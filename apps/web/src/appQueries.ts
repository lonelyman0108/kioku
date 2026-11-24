import type { KeyInfo } from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

// 客户端的改动会影响别处的缓存：客户端列表、访问密钥与权限矩阵、人格详情（列出以其为默认人格的客户端）
export function refreshClientCaches(queryClient: QueryClient, circleId: string, clientId?: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['clients', circleId] }),
    queryClient.invalidateQueries({ queryKey: ['persona', circleId] }),
    ...(clientId
      ? [
          queryClient.invalidateQueries({ queryKey: ['keys', circleId, clientId] }),
          queryClient.invalidateQueries({ queryKey: ['key-matrix', circleId, clientId] }),
        ]
      : []),
  ])
}

// 一个访问密钥的权限范围。岩芯每个访问密钥一个请求，来回切页不重发（KEY_MATRIX_STALE_TIME）
export const keyMatrixKey = (
  circleId: string,
  clientId: string,
  key: Pick<KeyInfo, 'id' | 'effectiveScopes'> & Partial<Pick<KeyInfo, 'circleGrants'>>,
) =>
  [
    'key-matrix',
    circleId,
    clientId,
    key.id,
    JSON.stringify(key.effectiveScopes),
    JSON.stringify(key.circleGrants ?? []),
  ] as const
export const KEY_MATRIX_STALE_TIME = 60_000

// 删掉的客户端：它的访问密钥与权限矩阵不再请求（请求只会得到 404），直接去掉缓存
export function forgetClient(queryClient: QueryClient, circleId: string, clientId: string) {
  queryClient.removeQueries({ queryKey: ['keys', circleId, clientId] })
  queryClient.removeQueries({ queryKey: ['key-matrix', circleId, clientId] })
  return refreshClientCaches(queryClient, circleId)
}
