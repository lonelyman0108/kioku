import { ref } from 'vue'

// 管理界面里有没有没保存的修改。编辑器登记自己的状态，离开（切记忆、切页面、退出登录）前统一确认一次；
// 确认过就清掉，同一次离开不会被不同的地方重复询问
export const hasUnsavedChanges = ref(false)

export function confirmDiscard(): boolean {
  if (!hasUnsavedChanges.value) return true
  if (!window.confirm('有未保存的修改，离开后会丢失。确定离开吗？')) return false
  hasUnsavedChanges.value = false
  return true
}
