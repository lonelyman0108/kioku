import type { Router } from 'vue-router'

// 连接失败页的重试：走一遍路由，看还有没有留在这一页

const SAME_SITE = 'http://kioku.invalid'

// 只回到站内路径。这个地址还会交给 location.assign，所以按浏览器的解析结果核对：
// /\example.com、夹了制表符的写法看着是站内路径，解析出来是别的站点；
// /.//example.com 解析出来的路径以 // 开头，交给浏览器时又成了别的站点
export function retryTarget(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/'
  try {
    const url = new URL(next, SAME_SITE)
    if (url.origin !== SAME_SITE || url.pathname.startsWith('//')) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

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
