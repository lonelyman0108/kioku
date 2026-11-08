import { reactive, watch, type Ref } from 'vue'

// 一个小节里几块表单的改动合起来报给页面：任意一块有改动就算有。各块经 v-model:dirty 写进返回的对象
export function useDirtyParts<K extends string>(model: Ref<boolean>, keys: readonly K[]) {
  const parts = reactive(Object.fromEntries(keys.map((k) => [k, false]))) as Record<K, boolean>
  watch(
    () => keys.some((k) => parts[k]),
    (dirty) => (model.value = dirty),
    { immediate: true },
  )
  return parts
}
