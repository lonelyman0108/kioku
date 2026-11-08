import { inject, type InjectionKey } from 'vue'

// 退出登录的整套流程（确认未保存的改动、退出、清缓存、回登录页）只在外壳里写一份，由外壳 provide。
// 登录设备里退出当前设备也走它
export const LOGOUT: InjectionKey<() => Promise<void>> = Symbol('logout')

export function useLogout(): () => Promise<void> {
  const logout = inject(LOGOUT)
  if (!logout) throw new Error('useLogout 只能在管理界面的外壳里用')
  return logout
}
