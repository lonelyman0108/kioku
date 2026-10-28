import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

// 输入停下来一会儿才跟着变的文字（去掉首尾空白），查找框用它，免得每敲一个字发一次请求
export function useDebounced(source: Ref<string>, delay = 300): Ref<string> {
  const value = ref(source.value.trim())
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(source, (next) => {
    clearTimeout(timer)
    timer = setTimeout(() => (value.value = next.trim()), delay)
  })
  onBeforeUnmount(() => clearTimeout(timer))
  return value
}
