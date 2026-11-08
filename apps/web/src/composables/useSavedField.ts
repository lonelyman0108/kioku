import { computed, ref, watch, type Ref } from 'vue'

// 一项数值设置的表单值：和载入时的基准比算不算改动，不和服务端最新的值比。
// 服务端的值变了（别处改过、后台重取）而本地没改时，基准与表单一起跟上；本地改过时都不动，免得冲掉输入。
// 数字框清空时值是 null 或 undefined，不在范围里的算不合法，保存前要拦下并说明
export function useSavedField(
  saved: () => number | undefined,
  range: { min: number; max: number },
) {
  const value: Ref<number | null | undefined> = ref(saved())
  const baseline = ref<number | undefined>(saved())
  const changed = computed(() => baseline.value !== undefined && value.value !== baseline.value)
  const valid = computed(() => {
    const v = value.value
    return typeof v === 'number' && Number.isInteger(v) && v >= range.min && v <= range.max
  })
  watch(saved, (next) => {
    if (next === undefined || changed.value) return
    baseline.value = next
    value.value = next
  })
  return {
    value,
    changed,
    // 改了但不合法：保存条上禁用保存，行里写出范围
    invalid: computed(() => changed.value && !valid.value),
    // 保存成功之后以存下的值为新的基准
    commit(next: number) {
      baseline.value = next
      value.value = next
    },
    reset() {
      value.value = baseline.value
    },
  }
}
