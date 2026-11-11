import type { TuningKey, TuningValues } from '@kioku/contracts'
import { computed, reactive, watch } from 'vue'

import { fromFieldValue, rangeOf, TUNING_META, toFieldValue } from '../advancedSettings'
import { fieldProblems, useSavedField } from './useSavedField'

// 一级的几项高级设置：每项一个 useSavedField，基准是这一级的生效值（覆盖了就是覆盖的值，否则是上一级的）。
// 覆盖没覆盖以服务端为准（overridden：服务端说这一级覆盖了哪几项），不按值猜：覆盖的值碰巧等于上一级时
// 照样是覆盖，恢复要显式写 null，否则上一级之后改了这里不跟。
// 本地的来源：点了恢复就是沿用（之后又编辑过就是覆盖）；改了值就是覆盖；没动过就和服务端一样
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

  // 点了恢复、之后没再编辑的项：保存时发 null，值跟着上一级走
  const restored = reactive(Object.fromEntries(keys.map((k) => [k, false]))) as Record<K, boolean>
  const savedOwn = (key: K) => overridden()?.has(key) ?? false
  const parentValue = (key: K) => {
    const parent = inherited()
    return parent ? toFieldValue(parent[key]) : undefined
  }
  // 这里自己写表单值（恢复、跟上一级）时为 true：别的写入都是用户在编辑
  let writing = false
  const write = (key: K, value: number) => {
    writing = true
    try {
      fields[key].value.value = value
    } finally {
      writing = false
    }
  }
  for (const key of keys) {
    // 用户编辑过就不再算恢复：之后特意填回和上一级相同的值是要钉住它，照覆盖发值。
    // 同步触发，才分得清这次写入是不是这里自己写的
    watch(
      fields[key].value,
      () => {
        if (!writing) restored[key] = false
      },
      { flush: 'sync' },
    )
    // 恢复之后、保存之前上一级的值变了（后台重取）：表单值跟上，不把旧的上一级的值当覆盖发出去
    watch(
      () => parentValue(key),
      (value) => {
        if (restored[key] && value !== undefined) write(key, value)
      },
      { flush: 'sync' },
    )
  }
  const own = (key: K) => {
    if (restored[key]) return false
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
    write(key, value)
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
  const valuesNow = () =>
    Object.fromEntries(keys.map((k) => [k, fields[k].value.value])) as Record<
      K,
      number | null | undefined
    >
  // 提交时的表单值，连同当时已恢复的项：保存成功后只清这些项的恢复标记
  const restoredAt = new WeakMap<object, K[]>()
  const snapshot = () => {
    const submitted = valuesNow()
    restoredAt.set(
      submitted,
      keys.filter((k) => restored[k]),
    )
    return submitted
  }
  // 保存成功：服务端返回的生效值是新的基准；保存期间又改了的输入留着
  const commit = (submitted: Record<K, number | null | undefined>, stored: TuningValues) => {
    for (const key of keys) {
      const value = submitted[key]
      if (typeof value === 'number') fields[key].commit(value, toFieldValue(stored[key]))
    }
    // 保存期间才点的恢复不在这次请求里，留到下一次保存
    for (const key of restoredAt.get(submitted) ?? []) restored[key] = false
  }
  const reset = () =>
    keys.forEach((k) => {
      fields[k].reset()
      restored[k] = false
    })
  // 给只报改动的子组件（BootExtrasRow）：各项的表单值、来源，以及改一项
  const values = computed(() => valuesNow())
  const sources = computed(
    () =>
      Object.fromEntries(keys.map((k) => [k, sourceOf(k)])) as Record<
        K,
        'inherited' | 'overridden'
      >,
  )
  const set = (key: TuningKey, value: number | null) => {
    if (!(keys as readonly TuningKey[]).includes(key)) return
    // 子组件报上来的都是用户的编辑，值没变也算（值相同时上面的 watch 不触发）
    restored[key as K] = false
    fields[key as K].value.value = value
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
