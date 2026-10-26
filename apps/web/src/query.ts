import { QueryCache, QueryClient } from '@tanstack/vue-query'

import { ApiError } from './api/client'

// 当前登录账号的缓存键；为 null 表示未登录
export const ME_KEY = ['me'] as const

// 全局只有一个 QueryClient：路由守卫和页面共用同一份「当前账号」缓存
export const queryClient = new QueryClient({
  // 任何请求返回 401（会话过期、在别的标签页退出）都重新确认当前账号：变成 null 后布局会带人回登录页
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== ME_KEY[0]) {
        void queryClient.invalidateQueries({ queryKey: ME_KEY })
      }
    },
  }),
  defaultOptions: {
    queries: {
      // 401、403、404 是确定的结果，重试没有意义
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      staleTime: 10_000,
    },
  },
})
