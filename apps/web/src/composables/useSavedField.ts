import { computed, readonly, ref, watch, type Ref } from 'vue'

// 填得不对时的说法：保存条上接在这一项的名字后面
export const FIELD_ISSUES = {
  empty: '未填写',
  fraction: '需为整数',
  range: '超出范围',
} as const
export type FieldIssue = keyof typeof FIELD_ISSUES

// 一项数值设置的表单值。基准永远是服务端最新的值，改动 = 表单 ≠ 基准：
// 服务端的值变了（别处改过、后台重取）时基准跟上；本地没改（表单等于旧基准）时表单一起跟上，改过就留着输入。
// 放弃回到最新的基准。数字框清空时值是 null，不是整数、不在范围里的都不合法，保存前要拦下并说明
export function useSavedField(
  saved: () => number | undefined,
  range: { min: number; max: number },
) {
  const value: Ref<number | null | undefined> = ref(saved())
  const baseline = ref<number | undefined>(saved())
  const changed = computed(() => baseline.value !== undefined && value.value !== baseline.value)
  const issue = computed<FieldIssue | null>(() => {
    if (!changed.value) return null
    const v = value.value
    if (typeof v !== 'number' || Number.isNaN(v)) return 'empty'
    if (!Number.isInteger(v)) return 'fraction'
    return v < range.min || v > range.max ? 'range' : null
  })
  watch(saved, (next) => {
    if (next === undefined) return
    if (value.value === baseline.value) value.value = next
    baseline.value = next
  })
  return {
    value,
    baseline: readonly(baseline),
    changed,
    issue,
    invalid: computed(() => issue.value !== null),
    // 保存成功：存下的值是新的基准；保存期间又改了输入时留着新输入，只更新基准
    commit(submitted: number, stored: number) {
      if (value.value === submitted) value.value = stored
      baseline.value = stored
    },
    reset() {
      value.value = baseline.value
    },
  }
}

// 保存条上的说明：哪几项填得不对、怎么不对。都对时为 null
export function fieldProblems(
  fields: { label: string; issue: FieldIssue | null }[],
): string | null {
  const parts = fields.flatMap((f) => (f.issue ? [`${f.label}：${FIELD_ISSUES[f.issue]}`] : []))
  return parts.length ? parts.join('；') : null
}
