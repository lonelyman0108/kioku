import { QueryClient } from '@tanstack/vue-query'

import { readFailure, retryable } from './api/client'

// 当前登录账号的缓存键；为 null 表示未登录
export const ME_KEY = ['me'] as const

// 全局只有一个 QueryClient：路由守卫和页面共用同一份「当前账号」缓存
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 确定的结果（401、403、404、契约对不上）重试没有意义，规则见 retryable
      retry: (count, error) => retryable(error) && count < 2,
      staleTime: 10_000,
    },
  },
})

// 一样读取的状态，ReadFailureNote 按它写错误、给重试、转圈，有没有读到过内容看 data。
// TanStack Query 的返回值就是这个形状；不是查询的读取（记忆目录的根节点）、几样查询合起来的一组，也照这个形状给
export interface ReadState {
  data: { readonly value: unknown }
  error: { readonly value: unknown }
  isFetching: { readonly value: boolean }
  refetch: () => unknown
}

interface ReadQuery extends ReadState {
  isError: { readonly value: boolean }
}

// 一页读好几样时的读取失败：同一句说法、能不能再读都一样的只提示一次。每条的重试只重读这一组，转圈也只看它们，
// 别的查询在后台刷新不算；一组里每样都读到过内容时，才算刷新失败
export function failedReads(
  queries: readonly ReadQuery[],
  fallback?: string,
): { key: string; message: string; read: ReadState }[] {
  const groups = new Map<string, { message: string; failed: ReadQuery[] }>()
  for (const query of queries) {
    if (!query.isError.value) continue
    const message = readFailure(query.error.value, fallback)
    const key = `${retryable(query.error.value) ? 'retry' : 'final'}:${message}`
    const group = groups.get(key) ?? { message, failed: [] }
    group.failed.push(query)
    groups.set(key, group)
  }
  return [...groups].map(([key, { message, failed }]) => ({
    key,
    message,
    read: {
      data: {
        get value() {
          return failed.every((query) => query.data.value != null) ? failed : undefined
        },
      },
      error: {
        get value() {
          return failed[0]!.error.value
        },
      },
      isFetching: {
        get value() {
          return failed.some((query) => query.isFetching.value)
        },
      },
      refetch: () => {
        for (const query of failed) void query.refetch()
      },
    },
  }))
}
