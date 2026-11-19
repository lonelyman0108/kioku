<script setup lang="ts">
import {
  BUILTIN_FACET_DIMENSIONS,
  BUILTIN_FACET_KEYS,
  FacetTermSlug,
  normalizeWhen,
  type FacetDimensionView,
  type FacetVocabularyView,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive } from 'vue'

import { api } from '../api/endpoints'
import { icons } from '../icons'
import { whenLabel } from '../memoryDetail'

const props = withDefaults(
  defineProps<{
    circleId: string
    vocabulary?: FacetVocabularyView | null
    lockedRealms?: readonly string[] | null
    disabled?: boolean
  }>(),
  {
    vocabulary: undefined,
    lockedRealms: undefined,
    disabled: false,
  },
)

const modelValue = defineModel<Record<string, string[]>>({ required: true })

const facetsQuery = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: computed(() => props.vocabulary === undefined && Boolean(props.circleId)),
})

const vocab = computed(() => props.vocabulary ?? facetsQuery.data.value ?? null)

const dimensions = computed<FacetDimensionView[]>(() => {
  if (vocab.value?.dimensions.length) return vocab.value.dimensions
  return BUILTIN_FACET_KEYS.map((key) => ({
    ...BUILTIN_FACET_DIMENSIONS[key],
    builtin: true,
  }))
})

const normalized = computed(() => normalizeWhen(modelValue.value))
const hasConditions = computed(() => Object.keys(normalized.value).length > 0)
const summary = computed(() => whenLabel(normalized.value, vocab.value ?? undefined))

function termsForDimension(dimKey: string) {
  const registered = (vocab.value?.terms ?? []).filter((t) => t.dimensionKey === dimKey)
  const known = new Set(registered.map((t) => t.slug))
  const extra = (normalized.value[dimKey] ?? [])
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, label: slug }))
  return [...registered.map((t) => ({ slug: t.slug, label: t.label })), ...extra]
}

function isSelected(dimKey: string, slug: string): boolean {
  return (normalized.value[dimKey] ?? []).includes(slug)
}

function isDimLocked(dimKey: string): boolean {
  return (
    props.disabled ||
    (dimKey === 'realm' && props.lockedRealms !== undefined && props.lockedRealms !== null)
  )
}

function toggleTerm(dimKey: string, slug: string) {
  if (isDimLocked(dimKey)) return
  const next: Record<string, string[]> = { ...normalized.value }
  const current = next[dimKey] ?? []
  if (current.includes(slug)) {
    const rest = current.filter((s) => s !== slug)
    if (rest.length) next[dimKey] = rest
    else delete next[dimKey]
  } else {
    next[dimKey] = [...current, slug]
  }
  modelValue.value = normalizeWhen(next)
}

function clearAll() {
  if (props.disabled) return
  if (props.lockedRealms?.length) {
    modelValue.value = normalizeWhen({ realm: props.lockedRealms })
    return
  }
  modelValue.value = {}
}

const customInputs = reactive<Record<string, string>>({})
const customErrors = reactive<Record<string, string | null>>({})

function addCustomTerm(dimKey: string) {
  if (isDimLocked(dimKey)) return
  const parsed = FacetTermSlug.safeParse(customInputs[dimKey] ?? '')
  if (!parsed.success) {
    customErrors[dimKey] = parsed.error.issues[0]?.message ?? '标识格式有误'
    return
  }
  customErrors[dimKey] = null
  const slug = parsed.data
  const current = normalized.value[dimKey] ?? []
  if (!current.includes(slug)) {
    modelValue.value = normalizeWhen({
      ...normalized.value,
      [dimKey]: [...current, slug],
    })
  }
  customInputs[dimKey] = ''
}
</script>

<template>
  <div class="facet-picker">
    <div class="facet-summary">
      <span class="facet-summary-label">
        <UIcon :name="icons.facets" class="facet-summary-icon" />
        <span>适用切面：</span>
        <strong>{{ summary }}</strong>
      </span>
      <UButton
        v-if="hasConditions && !disabled"
        type="button"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="clearAll"
      >
        设为默认（无条件）
      </UButton>
    </div>

    <div class="facet-dims">
      <div v-for="dim in dimensions" :key="dim.key" class="facet-dim">
        <div class="facet-dim-head">
          <span class="facet-dim-name">{{ dim.name }}</span>
          <span class="facet-dim-key">{{ dim.key }}</span>
          <span
            v-if="dim.key === 'realm' && lockedRealms !== undefined && lockedRealms !== null"
            class="facet-dim-lock"
          >
            机密词条各切片须保持同一场域
          </span>
        </div>

        <div class="facet-chips" role="group" :aria-label="dim.name">
          <button
            v-for="term in termsForDimension(dim.key)"
            :key="term.slug"
            type="button"
            class="facet-chip"
            :class="{ selected: isSelected(dim.key, term.slug) }"
            :aria-pressed="isSelected(dim.key, term.slug)"
            :disabled="isDimLocked(dim.key)"
            :title="term.slug"
            @click="toggleTerm(dim.key, term.slug)"
          >
            <span>{{ term.label }}</span>
            <span v-if="term.label !== term.slug" class="facet-chip-slug">{{ term.slug }}</span>
          </button>
          <span v-if="!termsForDimension(dim.key).length && !dim.autoRegister" class="facet-empty">
            词表中暂无词条
          </span>
        </div>

        <div v-if="dim.autoRegister && !isDimLocked(dim.key)" class="facet-custom">
          <UInput
            v-model="customInputs[dim.key]"
            size="xs"
            class="w-48 font-mono"
            placeholder="输入项目标识后回车"
            :aria-label="`添加${dim.name}`"
            @keydown.enter.prevent="addCustomTerm(dim.key)"
          />
          <UButton
            type="button"
            size="xs"
            color="neutral"
            variant="outline"
            @click="addCustomTerm(dim.key)"
          >
            添加
          </UButton>
          <span v-if="customErrors[dim.key]" class="facet-custom-error">
            {{ customErrors[dim.key] }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.facet-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
}
.facet-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
}
.facet-summary-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-text-muted);
}
.facet-summary-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
}
.facet-summary-label strong {
  font-weight: 500;
  color: var(--ui-text);
}
.facet-dims {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.facet-dim {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.facet-dim-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}
.facet-dim-name {
  font-weight: 500;
  color: var(--ui-text);
}
.facet-dim-key {
  font-family: var(--font-mono);
  color: var(--ui-text-muted);
}
.facet-dim-lock {
  color: var(--ui-text-muted);
}
.facet-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}
.facet-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text);
  background: var(--ui-bg);
  cursor: pointer;
}
.facet-chip:hover:not(:disabled) {
  background: var(--ui-bg-elevated);
}
.facet-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
.facet-chip.selected {
  background: var(--strata-selected);
  border-color: var(--strata-selected-frame);
  color: var(--strata-on-selected);
}
.facet-chip-slug {
  font-family: var(--font-mono);
  color: var(--ui-text-muted);
}
.facet-chip.selected .facet-chip-slug {
  color: var(--strata-on-selected-muted);
}
.facet-empty {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.facet-custom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.facet-custom-error {
  font-size: 12px;
  color: var(--ui-error);
}
</style>
