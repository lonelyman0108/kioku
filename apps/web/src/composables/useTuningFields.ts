import type { TuningKey, TuningValues } from '@kioku/contracts'
import { computed, reactive } from 'vue'

import { fromFieldValue, rangeOf, TUNING_META, toFieldValue } from '../advancedSettings'
import { fieldProblems, useSavedField } from './useSavedField'

// 一级的几项高级设置：每项一个 useSavedField，基准是这一级的生效值（覆盖了就是覆盖的值，否则是上一级的）。
// 覆盖没覆盖以服务端为准（overridden：服务端说这一级覆盖了哪几项），不按值猜：覆盖的值碰巧等于上一级时
// 照样是覆盖，恢复要显式写 null，否则上一级之后改了这里不跟。
// 本地的来源：点了恢复就是沿用（之后又改了值就是覆盖）；改了值就是覆盖；没动过就和服务端一样
export function useTuningFields<K extends TuningKey>(
  keys: readonly K[],
  effective: () => TuningValues | undefined,
  inherited: () => TuningValues | undefined,
  overridden: () => ReadonlySet<TuningKey> | undefined,
) {
  const fields = Object.fromEntries(
    keys.map((key) => {
      const saved = () => {
        const v = effective()?.[key]
        return v === undefined ? undefined : toFieldValue(v)
      }
      return [key, useSavedField(saved, rangeOf(key))]
    }),
  ) as Record<K, ReturnType<typeof useSavedField>>

  // 点了恢复、还没再改的项
  const restored = reactive(Object.fromEntries(keys.map((k) => [k, false]))) as Record<K, boolean>
  const savedOwn = (key: K) => overridden()?.has(key) ?? false
  const parentValue = (key: K) => {
    const parent = inherited()
    return parent ? toFieldValue(parent[key]) : undefined
  }
  // 恢复之后又改成别的值：又是覆盖
  const own = (key: K) => {
    if (restored[key] && fields[key].value.value === parentValue(key)) return false
    return fields[key].changed.value || savedOwn(key)
  }
  const isChanged = (key: K) => fields[key].changed.value || own(key) !== savedOwn(key)

  const changedKeys = computed(() => keys.filter(isChanged))
  const problem = computed(() =>
    fieldProblems(keys.map((k) => ({ label: TUNING_META[k].label, issue: fields[k].issue.value }))),
  )
  const sourceOf = (key: K): 'inherited' | 'overridden' => (own(key) ? 'overridden' : 'inherited')
  const restore = (key: K) => {
    const value = parentValue(key)
    if (value === undefined) return
    fields[key].value.value = value
    restored[key] = true
  }
  // 修改请求：恢复的项写 null，覆盖了的改动写值
  const patch = () => {
    const body: Record<string, number | boolean | null> = {}
    for (const key of keys) {
      if (!isChanged(key)) continue
      const value = fields[key].value.value
      if (!own(key)) body[key] = null
      else if (typeof value === 'number') body[key] = fromFieldValue(key, value)
    }
    return body
  }
  const snapshot = () =>
    Object.fromEntries(keys.map((k) => [k, fields[k].value.value])) as Record<
      K,
      number | null | undefined
    >
  // 保存成功：服务端返回的生效值是新的基准；保存期间又改了的输入留着
  const commit = (submitted: Record<K, number | null | undefined>, stored: TuningValues) => {
    for (const key of keys) {
      const value = submitted[key]
      if (typeof value === 'number') fields[key].commit(value, toFieldValue(stored[key]))
      restored[key] = false
    }
  }
  const reset = () =>
    keys.forEach((k) => {
      fields[k].reset()
      restored[k] = false
    })
  // 给只报改动的子组件（BootExtrasRow）：各项的表单值、来源，以及改一项
  const values = computed(() => snapshot())
  const sources = computed(
    () =>
      Object.fromEntries(keys.map((k) => [k, sourceOf(k)])) as Record<
        K,
        'inherited' | 'overridden'
      >,
  )
  const set = (key: TuningKey, value: number | null) => {
    if ((keys as readonly TuningKey[]).includes(key)) fields[key as K].value.value = value
  }
  return {
    fields,
    changedKeys,
    problem,
    sourceOf,
    restore,
    patch,
    commit,
    snapshot,
    reset,
    values,
    sources,
    set,
  }
}

export type TuningFields<K extends TuningKey> = ReturnType<typeof useTuningFields<K>>
