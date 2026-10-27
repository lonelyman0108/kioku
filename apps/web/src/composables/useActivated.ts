import { onActivated, onDeactivated, ref } from 'vue'

// 组件在 KeepAlive 里被切走时为 false，切回来为 true；不在 KeepAlive 里时一直是 true。
// 给查询的 enabled 用：切走的视图不跟着失效与回到标签页重新拉取，切回来时过期了才拉
export function useActivated() {
  const active = ref(true)
  onActivated(() => (active.value = true))
  onDeactivated(() => (active.value = false))
  return active
}
