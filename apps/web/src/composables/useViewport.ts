import { onBeforeUnmount, onMounted, shallowRef } from 'vue'

// 视口的宽高，窗口变化时跟着变：要按尺寸算像素的图形用，能写成 CSS 媒体查询的不用它
export function useViewport() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight })
  const viewport = shallowRef(read())
  const update = () => (viewport.value = read())
  onMounted(() => window.addEventListener('resize', update))
  onBeforeUnmount(() => window.removeEventListener('resize', update))
  return viewport
}
