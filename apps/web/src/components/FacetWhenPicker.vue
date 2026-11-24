<script setup lang="ts">
import {
  BUILTIN_FACET_DIMENSIONS,
  BUILTIN_FACET_KEYS,
  FacetTermSlug,
  normalizeWhen,
  type FacetDimensionView,
  type FacetTermView,
  type FacetVocabularyView,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive } from 'vue'

import { api } from '../api/endpoints'
import { icons } from '../icons'
import { facetMatchModeLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import { circleSettingsRoute } from '../settingsSections'
import ReadFailureNote from './strata/ReadFailureNote.vue'

const props = withDefaults(
  defineProps<{
    circleId: string
    vocabulary?: FacetVocabularyView | null
    lockedRealms?: readonly string[] | null
    excludeDimensions?: readonly string[]
    mode?: 'variant' | 'context'
    disabled?: boolean
  }>(),
  {
    vocabulary: undefined,
    lockedRealms: undefined,
    excludeDimensions: undefined,
    mode: 'variant',
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
const selfFetching = computed(() => props.vocabulary === undefined)

const dimensions = computed<FacetDimensionView[]>(() => {
  const excluded = new Set(props.excludeDimensions ?? [])
  const raw: FacetDimensionView[] = vocab.value?.dimensions.length
    ? vocab.value.dimensions
    : BUILTIN_FACET_KEYS.map((key) => ({
        ...BUILTIN_FACET_DIMENSIONS[key],
        builtin: true,
      }))
  return raw.filter((d) => !excluded.has(d.key))
})

const normalized = computed(() => normalizeWhen(modelValue.value))
const hasLockedRealms = computed(
  () => props.lockedRealms !== undefined && props.lockedRealms !== null,
)
const hasClearableConditions = computed(() => {
  if (!hasLockedRealms.value) return Object.keys(normalized.value).length > 0
  return Object.keys(normalized.value).some((k) => k !== 'realm')
})
const summary = computed(() => whenLabel(normalized.value, vocab.value ?? undefined))
const summaryPrefix = computed(() => (props.mode === 'context' ? '默认语境：' : '适用条件：'))
const clearLabel = computed(() =>
  props.mode === 'context'
    ? '清空语境'
    : hasLockedRealms.value
      ? '清空其他条件'
      : '设为默认（无条件）',
)

interface TermItem {
  slug: string
  label: string
  hint: string
}

function termHint(term: FacetTermView): string {
  const parts = [term.slug]
  if (term.aliases.length) parts.push(`唤醒别名：${term.aliases.join('、')}`)
  if (Object.keys(term.implies).length) {
    parts.push(`自动关联：${whenLabel(term.implies, vocab.value ?? undefined)}`)
  }
  return parts.join('\n')
}

function termsForDimension(dimKey: string): TermItem[] {
  const registered = (vocab.value?.terms ?? []).filter((t) => t.dimensionKey === dimKey)
  const known = new Set(registered.map((t) => t.slug))
  const extra = (normalized.value[dimKey] ?? [])
    .filter((slug) => !known.has(slug))
    .map((slug) => ({ slug, label: slug, hint: slug }))
  return [...registered.map((t) => ({ slug: t.slug, label: t.label, hint: termHint(t) })), ...extra]
}

function isSelected(dimKey: string, slug: string): boolean {
  return (normalized.value[dimKey] ?? []).includes(slug)
}

function isDimLocked(dimKey: string): boolean {
  return props.disabled || (dimKey === 'realm' && hasLockedRealms.value)
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
  if (hasLockedRealms.value) {
    modelValue.value = props.lockedRealms?.length
      ? normalizeWhen({ realm: props.lockedRealms })
      : {}
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
        <span>{{ summaryPrefix }}</span>
        <strong>{{ summary }}</strong>
      </span>
      <UButton
        v-if="hasClearableConditions && !disabled"
        type="button"
        size="xs"
        color="neutral"
        variant="ghost"
        @click="clearAll"
      >
        {{ clearLabel }}
      </UButton>
    </div>

    <ReadFailureNote
      v-if="selfFetching && facetsQuery.isError.value"
      :query="facetsQuery"
      fallback="语境词典读取失败"
      size="xs"
    />
    <div v-else-if="selfFetching && facetsQuery.isPending.value" class="space-y-2">
      <USkeleton v-for="n in 2" :key="n" class="h-6 w-full" />
    </div>
    <div v-else class="facet-dims">
      <div v-for="dim in dimensions" :key="dim.key" class="facet-dim">
        <div class="facet-dim-head">
          <span class="facet-dim-name">{{ dim.name }}</span>
          <span class="facet-dim-key">{{ dim.key }}</span>
          <span class="facet-dim-mode">{{ facetMatchModeLabels[dim.matchMode] }}</span>
          <span v-if="dim.description" class="facet-dim-desc">{{ dim.description }}</span>
          <span v-if="dim.key === 'realm' && hasLockedRealms" class="facet-dim-lock">
            机密记忆各变体须保持同一场域
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
            :title="term.hint"
            @click="toggleTerm(dim.key, term.slug)"
          >
            <span>{{ term.label }}</span>
            <span v-if="term.label !== term.slug" class="facet-chip-slug">{{ term.slug }}</span>
          </button>
          <span v-if="!termsForDimension(dim.key).length && !dim.autoRegister" class="facet-empty">
            语境词典中暂无条件项<template v-if="circleId">
              ·
              <RouterLink
                :to="circleSettingsRoute(circleId, 'vocabulary')"
                class="facet-vocab-link"
              >
                去语境词典添加
              </RouterLink>
            </template>
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
.facet-dim-mode {
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  color: var(--ui-text-muted);
}
.facet-dim-desc {
  color: var(--ui-text-muted);
}
.facet-dim-lock {
  color: var(--ui-text-muted);
}
.facet-vocab-link {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.facet-vocab-link:hover {
  color: var(--ui-text-highlighted);
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
