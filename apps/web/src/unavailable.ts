import type { Router } from 'vue-router'

// 连接失败页的重试：走一遍路由，看还有没有留在这一页

// 只回到站内路径
export const retryTarget = (next: unknown): string =>
  typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/'

export type RetryResult = 'recovered' | 'unreachable' | 'assets'

export async function retryNavigation(router: Router, target: string): Promise<RetryResult> {
  try {
    await router.replace(target)
  } catch {
    // 接口通了，页面文件加载不到（例如刚升级，这个页面记着的文件名已经不在了）：导航直接 reject
    return 'assets'
  }
  // 还是连不上时守卫转回这一页，地址不变，导航也不报错
  return router.currentRoute.value.name === 'unavailable' ? 'unreachable' : 'recovered'
}
