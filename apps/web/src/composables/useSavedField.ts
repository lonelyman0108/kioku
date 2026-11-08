import { computed, readonly, ref, watch, type Ref } from 'vue'

// 填得不对时的说法：保存条上接在这一项的名字后面
export const FIELD_ISSUES = {
  empty: '未填写',
  fraction: '需为整数',
  precision: '最多两位小数',
  range: '超出范围',
  tooLong: '超出字数',
  control: '含不支持的字符',
} as const
export type FieldIssue = keyof typeof FIELD_ISSUES

// 契约里的 zod schema：只用它判断合不合法
export interface Checkable {
  safeParse(value: unknown): { success: boolean }
}

// 一项数值设置的表单值。基准永远是服务端最新的值，改动 = 表单 ≠ 基准：
// 服务端的值变了（别处改过、后台重取）时基准跟上；本地没改（表单等于旧基准）时表单一起跟上，改过就留着输入。
// 放弃回到最新的基准。数字框清空时值是 null，不是整数、不在范围里的都不合法，保存前要拦下并说明。
// 给了 schema（契约里这一项的定义）时合不合法以它为准，规则只有契约那一份；decimals 只决定说法（小数的项说「最多两位小数」）
export function useSavedField(
  saved: () => number | undefined,
  range: { min: number; max: number; schema?: Checkable; decimals?: boolean },
) {
  const value: Ref<number | null | undefined> = ref(saved())
  const baseline = ref<number | undefined>(saved())
  const changed = computed(() => baseline.value !== undefined && value.value !== baseline.value)
  const issue = computed<FieldIssue | null>(() => {
    if (!changed.value) return null
    const v = value.value
    if (typeof v !== 'number' || Number.isNaN(v)) return 'empty'
    if (v < range.min || v > range.max) return 'range'
    if (range.schema) {
      if (range.schema.safeParse(v).success) return null
      return range.decimals ? 'precision' : 'fraction'
    }
    return Number.isInteger(v) ? null : 'fraction'
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

// 一段文字设置（提示词的补充）的表单值，和 useSavedField 同一套基准规则：服务端没有这一项时基准是空串。
// 合不合法以契约的 schema 为准（例如 PromptSupplement）；maxChars 只用来计字数、挑说法：超出字数还是含不支持的字符
export function useSavedText(saved: () => string | undefined, schema: Checkable, maxChars: number) {
  const value = ref(saved() ?? '')
  const baseline = ref(saved() ?? '')
  const changed = computed(() => value.value !== baseline.value)
  const length = computed(() => [...value.value].length)
  const issue = computed<FieldIssue | null>(() => {
    if (!changed.value) return null
    if (schema.safeParse(value.value).success) return null
    return length.value > maxChars ? 'tooLong' : 'control'
  })
  watch(saved, (next) => {
    const text = next ?? ''
    if (value.value === baseline.value) value.value = text
    baseline.value = text
  })
  return {
    value,
    baseline: readonly(baseline),
    changed,
    length,
    issue,
    invalid: computed(() => issue.value !== null),
    commit(submitted: string, stored: string) {
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
