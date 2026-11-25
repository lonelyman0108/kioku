<script setup lang="ts">
import {
  BUILTIN_ENVS,
  normalizeSlugList,
  RUNTIME_FAMILIES,
  SceneSlug,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { envDisplayName } from '../labels'
import { runtimeName } from '../runtimes'

export interface SceneScopeValue {
  envs: string[]
  realms: string[]
  projects: string[]
  runtimes: string[]
}

const props = withDefaults(
  defineProps<{
    modelValue: SceneScopeValue
    facets?: EntryFacetsSummary | null
    disabled?: boolean
  }>(),
  { facets: null, disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [value: SceneScopeValue] }>()

const hasAnyScope = computed(
  () =>
    props.modelValue.envs.length > 0 ||
    props.modelValue.realms.length > 0 ||
    props.modelValue.projects.length > 0 ||
    props.modelValue.runtimes.length > 0,
)
const expanded = ref(hasAnyScope.value)
watch(hasAnyScope, (any) => {
  if (any) expanded.value = true
})

const envChoices = computed(() =>
  normalizeSlugList([...BUILTIN_ENVS, ...(props.facets?.envs ?? []), ...props.modelValue.envs]),
)
const realmChoices = computed(() =>
  normalizeSlugList([
    'work',
    'personal',
    ...(props.facets?.realms ?? []),
    ...props.modelValue.realms,
  ]),
)
const projectChoices = computed(() =>
  normalizeSlugList([...(props.facets?.projects ?? []), ...props.modelValue.projects]),
)

const draft = reactive({ env: '', realm: '', project: '' })
const draftError = ref<string | null>(null)

function patch(key: keyof SceneScopeValue, list: string[]) {
  emit('update:modelValue', {
    ...props.modelValue,
    [key]: normalizeSlugList(list),
  })
}

function toggle(key: keyof SceneScopeValue, slug: string) {
  if (props.disabled) return
  const current = props.modelValue[key]
  patch(key, current.includes(slug) ? current.filter((v) => v !== slug) : [...current, slug])
}

function addCustom(key: 'envs' | 'realms' | 'projects', inputKey: 'env' | 'realm' | 'project') {
  if (props.disabled) return
  const raw = draft[inputKey].trim()
  if (!raw) return
  const parsed = SceneSlug.safeParse(raw)
  if (!parsed.success) {
    draftError.value = parsed.error.issues[0]?.message ?? '标签格式有误'
    return
  }
  draftError.value = null
  if (!props.modelValue[key].includes(parsed.data)) {
    patch(key, [...props.modelValue[key], parsed.data])
  }
  draft[inputKey] = ''
}

function setUniversal() {
  if (props.disabled) return
  expanded.value = false
  draftError.value = null
  emit('update:modelValue', { envs: [], realms: [], projects: [], runtimes: [] })
}
</script>

<template>
  <div class="scope-picker">
    <div class="scope-head">
      <div class="scope-mode">
        <UButton
          type="button"
          size="xs"
          :color="!expanded ? 'primary' : 'neutral'"
          :variant="!expanded ? 'solid' : 'outline'"
          :disabled="disabled"
          @click="setUniversal"
        >
          所有环境
        </UButton>
        <UButton
          type="button"
          size="xs"
          :color="expanded ? 'primary' : 'neutral'"
          :variant="expanded ? 'solid' : 'outline'"
          :disabled="disabled"
          @click="expanded = true"
        >
          限定场景
        </UButton>
      </div>
      <span v-if="!expanded" class="text-xs text-muted">对全部系统、项目与场域生效</span>
    </div>

    <div v-if="expanded" class="scope-grid">
      <div class="scope-row">
        <span class="scope-label">环境</span>
        <div class="scope-chips">
          <UButton
            v-for="slug in envChoices"
            :key="slug"
            type="button"
            size="xs"
            :color="modelValue.envs.includes(slug) ? 'primary' : 'neutral'"
            :variant="modelValue.envs.includes(slug) ? 'solid' : 'outline'"
            :disabled="disabled"
            @click="toggle('envs', slug)"
          >
            {{ envDisplayName(slug) }}
          </UButton>
          <UInput
            v-model="draft.env"
            size="xs"
            placeholder="新增环境"
            class="w-24"
            :disabled="disabled"
            @keydown.enter.prevent="addCustom('envs', 'env')"
            @blur="addCustom('envs', 'env')"
          />
        </div>
      </div>

      <div class="scope-row">
        <span class="scope-label">场域</span>
        <div class="scope-chips">
          <UButton
            v-for="slug in realmChoices"
            :key="slug"
            type="button"
            size="xs"
            :color="modelValue.realms.includes(slug) ? 'primary' : 'neutral'"
            :variant="modelValue.realms.includes(slug) ? 'solid' : 'outline'"
            :disabled="disabled"
            @click="toggle('realms', slug)"
          >
            {{ slug }}
          </UButton>
          <UInput
            v-model="draft.realm"
            size="xs"
            placeholder="新增场域"
            class="w-24"
            :disabled="disabled"
            @keydown.enter.prevent="addCustom('realms', 'realm')"
            @blur="addCustom('realms', 'realm')"
          />
        </div>
      </div>

      <div class="scope-row">
        <span class="scope-label">项目</span>
        <div class="scope-chips">
          <UButton
            v-for="slug in projectChoices"
            :key="slug"
            type="button"
            size="xs"
            :color="modelValue.projects.includes(slug) ? 'primary' : 'neutral'"
            :variant="modelValue.projects.includes(slug) ? 'solid' : 'outline'"
            :disabled="disabled"
            @click="toggle('projects', slug)"
          >
            {{ slug }}
          </UButton>
          <UInput
            v-model="draft.project"
            size="xs"
            placeholder="项目名"
            class="w-28"
            :disabled="disabled"
            @keydown.enter.prevent="addCustom('projects', 'project')"
            @blur="addCustom('projects', 'project')"
          />
        </div>
      </div>

      <div class="scope-row">
        <span class="scope-label">客户端</span>
        <div class="scope-chips">
          <UButton
            v-for="rt in RUNTIME_FAMILIES"
            :key="rt"
            type="button"
            size="xs"
            :color="modelValue.runtimes.includes(rt) ? 'primary' : 'neutral'"
            :variant="modelValue.runtimes.includes(rt) ? 'solid' : 'outline'"
            :disabled="disabled"
            @click="toggle('runtimes', rt)"
          >
            {{ runtimeName(rt) }}
          </UButton>
        </div>
      </div>

      <p v-if="draftError" class="text-xs text-error" role="alert">{{ draftError }}</p>
    </div>
  </div>
</template>

<style scoped>
.scope-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.scope-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.scope-mode {
  display: inline-flex;
  gap: 4px;
}
.scope-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.scope-row {
  display: grid;
  grid-template-columns: 3.5rem minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}
.scope-label {
  padding-top: 3px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.scope-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
</style>
