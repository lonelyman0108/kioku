import { onScopeDispose, shallowRef, type Ref } from 'vue'

// 现在的时间，每分钟走一次：按时间算的显示（还剩几天、警示色、是否已过期）页面一直开着也会跟着变。
// 组件卸载时停下
export function useNow(intervalMs = 60_000): Readonly<Ref<Date>> {
  const now = shallowRef(new Date())
  const timer = setInterval(() => (now.value = new Date()), intervalMs)
  onScopeDispose(() => clearInterval(timer))
  return now
}
