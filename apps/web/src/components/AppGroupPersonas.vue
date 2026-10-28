<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { GroupPersonaRule } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'

// 按群换人格的规则：应用在这些群里用规则里的人格。整组替换，改一条就把整组发回去；只有应用主人能改
const props = defineProps<{ spaceId: string; appId: string; canManage: boolean }>()
const toast = useToast()
const queryClient = useQueryClient()

const rulesKey = computed(() => ['group-personas', props.spaceId, props.appId])
const rules = useQuery({
  queryKey: rulesKey,
  queryFn: () => api.groupPersonas(props.spaceId, props.appId),
})
const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
})
const personaItems = computed(() =>
  (personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
)
const personaName = (id: string) =>
  personas.data.value?.find((p) => p.id === id)?.name ?? '已删除的人格'

// 选群：按群名或群号到服务端查，输入停下来再查
const searchTerm = ref('')
const term = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(searchTerm, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => (term.value = value.trim()), 300)
})
const groups = useQuery({
  queryKey: computed(() => ['group-picker', props.spaceId, term.value]),
  queryFn: () => api.subjects(props.spaceId, { kind: 'group', q: term.value || undefined }),
  enabled: computed(() => props.canManage),
})
const groupItems = computed(() => {
  const taken = new Set(rules.data.value?.rules.map((r) => r.subjectId))
  return (groups.data.value?.items ?? [])
    .filter((g) => !taken.has(g.id))
    .map((g) => ({
      label: g.displayName,
      value: g.id,
      description: g.identities.map((i) => `${i.platform} ${i.externalId}`).join('、'),
    }))
})
const newGroup = ref<string | undefined>()
const newPersona = ref<string | undefined>()

const current = (): GroupPersonaRule[] =>
  (rules.data.value?.rules ?? []).map(({ subjectId, personaId }) => ({ subjectId, personaId }))

const saving = ref(false)
async function save(next: GroupPersonaRule[], done: string): Promise<boolean> {
  const sid = props.spaceId
  const id = props.appId
  saving.value = true
  try {
    const saved = await api.saveGroupPersonas(sid, id, { rules: next })
    queryClient.setQueryData(['group-personas', sid, id], saved)
    toast.add({ title: done, color: 'success' })
    return true
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
    return false
  } finally {
    saving.value = false
  }
}

async function add() {
  if (!newGroup.value || !newPersona.value) return
  const rule = { subjectId: newGroup.value, personaId: newPersona.value }
  if (await save([...current(), rule], '已添加规则')) {
    newGroup.value = undefined
    newPersona.value = undefined
  }
}
function change(subjectId: string, personaId: string) {
  void save(
    current().map((r) => (r.subjectId === subjectId ? { subjectId, personaId } : r)),
    '已保存',
  )
}
function remove(subjectId: string) {
  void save(
    current().filter((r) => r.subjectId !== subjectId),
    '已删除规则',
  )
}
</script>

<template>
  <div class="space-y-3">
    <div>
      <h2 class="text-sm font-medium">按群换人格</h2>
      <p class="text-xs text-muted">
        在这些群（或频道）里用指定的人格，boot、召回与写入都按它；其余的群、私聊和不带会话上下文的请求用默认人格。
      </p>
    </div>
    <USkeleton v-if="rules.isPending.value" class="h-10 w-full" />
    <UAlert
      v-else-if="rules.isError.value"
      color="error"
      variant="subtle"
      :title="rules.error.value instanceof ApiError ? rules.error.value.message : '读取失败'"
    />
    <template v-else>
      <ul v-if="rules.data.value?.rules.length" class="divide-y divide-default">
        <li
          v-for="rule in rules.data.value.rules"
          :key="rule.subjectId"
          class="flex flex-wrap items-center gap-2 py-2"
        >
          <RouterLink
            :to="{ name: 'subject', params: { spaceId, subjectId: rule.subjectId } }"
            class="min-w-0 flex-1 truncate text-sm hover:underline"
            >{{ rule.groupName }}</RouterLink
          >
          <USelect
            v-if="canManage"
            :model-value="rule.personaId"
            :items="personaItems"
            class="w-40"
            :aria-label="`「${rule.groupName}」用的人格`"
            :disabled="saving"
            @update:model-value="(v) => change(rule.subjectId, v as string)"
          />
          <span v-else class="text-sm">{{ personaName(rule.personaId) }}</span>
          <UButton
            v-if="canManage"
            :icon="icons.remove"
            color="neutral"
            variant="ghost"
            size="sm"
            :aria-label="`删除「${rule.groupName}」的规则`"
            :disabled="saving"
            @click="remove(rule.subjectId)"
          />
        </li>
      </ul>
      <p v-else class="text-sm text-muted">还没有规则：所有群都用默认人格。</p>
      <div v-if="canManage" class="flex flex-wrap items-center gap-2">
        <USelectMenu
          v-model="newGroup"
          v-model:search-term="searchTerm"
          :items="groupItems"
          value-key="value"
          ignore-filter
          :search-input="{ name: 'q', placeholder: '群名或群号', loading: groups.isFetching.value }"
          placeholder="选择群"
          aria-label="选择群"
          class="w-full sm:w-56"
        />
        <USelect
          v-model="newPersona"
          :items="personaItems"
          placeholder="选择人格"
          aria-label="选择人格"
          class="w-full sm:w-40"
        />
        <UButton
          variant="subtle"
          :icon="icons.add"
          :disabled="!newGroup || !newPersona"
          :loading="saving"
          @click="add"
          >添加</UButton
        >
      </div>
    </template>
  </div>
</template>
