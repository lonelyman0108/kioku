<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ClientGroupRule } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { useDebounced } from '../composables/useDebounced'
import { icons } from '../icons'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'

// 按群规则：可为指定群单独覆盖人格，并可开启单群强隔离锁
const props = defineProps<{
  circleId: string
  clientId: string
  canManage: boolean
  personas: { id: string; name: string }[]
  personasLoaded: boolean
}>()
const toast = useToast()
const queryClient = useQueryClient()

const rulesKey = computed(() => ['client-group-rules', props.circleId, props.clientId] as const)
const rules = useQuery({
  queryKey: rulesKey,
  queryFn: () => api.clientGroupRules(props.circleId, props.clientId),
})
const personaItems = computed(() => [
  { label: '沿用默认人格', value: null },
  ...props.personas.map((p) => ({ label: p.name, value: p.id })),
])
const personaName = (id: string | null) => {
  if (!id) return '沿用默认人格'
  return props.personasLoaded ? (props.personas.find((p) => p.id === id)?.name ?? id) : '…'
}

const searchTerm = ref('')
const term = useDebounced(searchTerm)
const pickerOpen = ref(false)
const groups = useQuery({
  queryKey: computed(() => ['group-picker', props.circleId, term.value] as const),
  queryFn: () => api.subjects(props.circleId, { kind: 'group', q: term.value || undefined }),
  enabled: computed(() => props.canManage && pickerOpen.value),
})
type GroupItem = { label: string; value: string; description: string }
const picked = ref<GroupItem | null>(null)
const groupItems = computed(() => {
  const taken = new Set(rules.data.value?.rules.map((r) => r.groupSubjectId))
  const found: GroupItem[] = (groups.data.value?.items ?? [])
    .filter((g) => !taken.has(g.id))
    .map((g) => ({
      label: g.displayName,
      value: g.id,
      description: g.identities.map((i) => `${i.platform} ${i.externalId}`).join('、'),
    }))
  const keep = picked.value
  return keep && !taken.has(keep.value) && !found.some((g) => g.value === keep.value)
    ? [keep, ...found]
    : found
})

const newGroup = ref<string | undefined>()
watch(newGroup, (id) => {
  picked.value = id ? (groupItems.value.find((g) => g.value === id) ?? picked.value) : null
})
const newPersona = ref<string | null>(null)
const newIsolate = ref(false)

watch(
  () => [props.circleId, props.clientId],
  () => {
    newGroup.value = undefined
    newPersona.value = null
    newIsolate.value = false
  },
)
watch(
  () => rules.data.value,
  (data) => {
    if (newGroup.value && data?.rules.some((r) => r.groupSubjectId === newGroup.value)) {
      newGroup.value = undefined
    }
  },
)

const canAdd = computed(() => Boolean(newGroup.value && (newPersona.value || newIsolate.value)))

const current = (): ClientGroupRule[] =>
  (rules.data.value?.rules ?? []).map(({ groupSubjectId, personaId, isolateGroupMemory }) => ({
    groupSubjectId,
    personaId,
    isolateGroupMemory,
  }))

const saving = ref(false)
async function save(next: ClientGroupRule[], done: string): Promise<boolean> {
  const cid = props.circleId
  const id = props.clientId
  const key = ['client-group-rules', cid, id] as const
  saving.value = true
  try {
    await queryClient.cancelQueries({ queryKey: key })
    const saved = await api.saveClientGroupRules(cid, id, { rules: next })
    queryClient.setQueryData(key, saved)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: ['personas', cid] }),
      queryClient.invalidateQueries({ queryKey: ['persona', cid] }),
      queryClient.invalidateQueries({ queryKey: ['clients', cid] }),
    ])
    toast.add({ title: done, color: 'success' })
    return true
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
    void queryClient.invalidateQueries({ queryKey: key })
    return false
  } finally {
    saving.value = false
  }
}

async function add() {
  if (!canAdd.value || !newGroup.value) return
  const rule: ClientGroupRule = {
    groupSubjectId: newGroup.value,
    personaId: newPersona.value,
    isolateGroupMemory: newIsolate.value,
  }
  if (await save([...current(), rule], '已添加按群规则')) {
    newGroup.value = undefined
    newPersona.value = null
    newIsolate.value = false
  }
}

function updateRule(groupSubjectId: string, patch: Partial<ClientGroupRule>) {
  const existing = current()
  const target = existing.find((r) => r.groupSubjectId === groupSubjectId)
  if (!target) return
  const updated: ClientGroupRule = { ...target, ...patch }
  if (!updated.personaId && !updated.isolateGroupMemory) {
    void save(
      existing.filter((r) => r.groupSubjectId !== groupSubjectId),
      '已移除空规则',
    )
    return
  }
  void save(
    existing.map((r) => (r.groupSubjectId === groupSubjectId ? updated : r)),
    '已保存',
  )
}

function remove(groupSubjectId: string) {
  void save(
    current().filter((r) => r.groupSubjectId !== groupSubjectId),
    '已删除规则',
  )
}
</script>

<template>
  <div class="group-rules-wrap">
    <p class="group-title">
      按群规则
      <Hint>
        可为指定群（或频道）单独覆盖人格，或开启单群隔离锁。开启单群隔离锁后，本群发言人的事实不会通过「跨群认人」流入其他群，其他群的印象也不会流入本群。每条规则须指定人格或开启隔离锁之一。
      </Hint>
    </p>
    <NoteLine v-if="rules.isError.value" tone="error">
      {{ readFailure(rules.error.value) }}
    </NoteLine>
    <USkeleton v-if="rules.isPending.value" class="h-10 w-full" />
    <template v-else-if="rules.data.value">
      <ul v-if="rules.data.value?.rules.length" class="group-rules">
        <li v-for="rule in rules.data.value.rules" :key="rule.groupSubjectId" class="rule-row">
          <RouterLink
            :to="{ name: 'contact', params: { circleId, subjectId: rule.groupSubjectId } }"
            class="group-name"
            :title="rule.groupName"
            >{{ rule.groupName }}</RouterLink
          >
          <USelect
            v-if="canManage"
            :model-value="rule.personaId"
            :items="personaItems"
            value-key="value"
            class="w-36"
            :aria-label="`「${rule.groupName}」使用的人格`"
            :disabled="saving"
            @update:model-value="
              (v) => updateRule(rule.groupSubjectId, { personaId: (v as string | null) ?? null })
            "
          />
          <span v-else class="group-persona">{{ personaName(rule.personaId) }}</span>

          <label v-if="canManage" class="lock-toggle" :title="'单群隔离锁'">
            <UIcon :name="icons.lock" class="inline-block size-3.5 text-muted" />
            <USwitch
              size="xs"
              :model-value="rule.isolateGroupMemory"
              :disabled="saving"
              :aria-label="`「${rule.groupName}」单群隔离锁`"
              @update:model-value="
                (v) => updateRule(rule.groupSubjectId, { isolateGroupMemory: v })
              "
            />
            <span class="lock-label">单群隔离锁</span>
          </label>
          <span v-else-if="rule.isolateGroupMemory" class="lock-badge">
            <UIcon :name="icons.lock" class="inline-block size-3" />
            单群隔离锁
          </span>

          <UButton
            v-if="canManage"
            :icon="icons.remove"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="`删除「${rule.groupName}」的规则`"
            :disabled="saving"
            @click="remove(rule.groupSubjectId)"
          />
        </li>
      </ul>
      <p v-else class="group-empty">暂无按群规则，所有群沿用客户端默认人格与跨群认人模式</p>
      <div v-if="canManage" class="group-add">
        <USelectMenu
          v-model="newGroup"
          v-model:search-term="searchTerm"
          v-model:open="pickerOpen"
          :items="groupItems"
          value-key="value"
          ignore-filter
          :search-input="{ name: 'q', placeholder: '群名或群号', loading: groups.isFetching.value }"
          placeholder="选择群"
          aria-label="选择群"
          class="w-full"
        />
        <USelect
          v-model="newPersona"
          :items="personaItems"
          value-key="value"
          placeholder="人格覆盖"
          aria-label="选择人格"
          class="w-full"
        />
        <label class="lock-toggle">
          <USwitch v-model="newIsolate" size="xs" aria-label="开启单群隔离锁" />
          <span class="lock-label">单群隔离</span>
        </label>
        <UButton
          color="primary"
          variant="outline"
          :disabled="!canAdd"
          :loading="saving"
          @click="add"
          >添加</UButton
        >
      </div>
      <p v-if="canManage && groups.isError.value" class="group-failed">
        {{ readFailure(groups.error.value) }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 14px;
}
.group-rules {
  margin-bottom: 7px;
}
.rule-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.group-name {
  flex: 1 1 8rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.group-persona {
  flex: none;
  color: var(--ui-text-muted);
}
.lock-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.lock-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.group-empty {
  margin-bottom: 7px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.group-failed {
  margin-top: 6px;
  font-size: 14px;
  color: var(--ui-error);
}
.group-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.group-add > :first-child {
  flex: 1 1 10rem;
}
.group-add > :nth-child(2) {
  flex: 1 1 9rem;
}
</style>
