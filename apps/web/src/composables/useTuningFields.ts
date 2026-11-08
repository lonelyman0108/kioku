import type { TuningKey, TuningValues } from '@kioku/contracts'
import { computed } from 'vue'

import { buildPatch, rangeOf, rowSource, TUNING_META, toFieldValue } from '../advancedSettings'
import { fieldProblems, useSavedField } from './useSavedField'

// 一级的几项高级设置：每项一个 useSavedField，基准是这一级的生效值（覆盖了就是覆盖的值，否则是上一级的）。
// 来源按表单里的值和上一级比：一样就是沿用，保存时写 null 去掉这一级的覆盖；恢复就是把值改回上一级的
export function useTuningFields<K extends TuningKey>(
  keys: readonly K[],
  effective: () => TuningValues | undefined,
  inherited: () => TuningValues | undefined,
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

  const changedKeys = computed(() => keys.filter((k) => fields[k].changed.value))
  const problem = computed(() =>
    fieldProblems(keys.map((k) => ({ label: TUNING_META[k].label, issue: fields[k].issue.value }))),
  )
  const sourceOf = (key: K) => {
    const parent = inherited()
    return parent ? rowSource(key, fields[key].value.value, parent[key]) : 'inherited'
  }
  const restore = (key: K) => {
    const parent = inherited()
    if (parent) fields[key].value.value = toFieldValue(parent[key])
  }
  const patch = () => {
    const parent = inherited()
    if (!parent) return {}
    return buildPatch(
      keys.map((key) => ({
        key,
        changed: fields[key].changed.value,
        value: fields[key].value.value,
      })),
      parent,
    )
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
    }
  }
  const reset = () => keys.forEach((k) => fields[k].reset())
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
