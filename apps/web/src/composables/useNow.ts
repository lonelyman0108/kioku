import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'

import { useActivated } from './useActivated'

// 现在的时间，每隔 intervalMs 走一次：按时间算的显示（还剩几天、警示色、是否已过期）页面一直开着也会跟着变。
// active 为 false 时停下（组件在 KeepAlive 里被切走，用不着在后台重渲染），回到 true 时马上换成现在再接着走；
// 默认跟着组件的启用与停用。组件卸载时停下
export function useNow(
  intervalMs = 60_000,
  active: Readonly<Ref<boolean>> = useActivated(),
): Readonly<Ref<Date>> {
  const now = shallowRef(new Date())
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }
  watch(
    active,
    (on) => {
      stop()
      if (!on) return
      now.value = new Date()
      timer = setInterval(() => (now.value = new Date()), intervalMs)
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(stop)
  return now
}
