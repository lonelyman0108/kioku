<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { GroupPersonaRule } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useDebounced } from '../composables/useDebounced'
import { icons } from '../icons'

// 按群换人格的规则：应用在这些群里用规则里的人格。整组替换，改一条就把整组发回去；只有应用主人能改
const props = defineProps<{
  spaceId: string
  appId: string
  canManage: boolean
  // 人格列表由应用详情页查好传进来
  personas: { id: string; name: string }[]
  personasLoaded: boolean
}>()
const toast = useToast()
const queryClient = useQueryClient()

const rulesKey = computed(() => ['group-personas', props.spaceId, props.appId])
const rules = useQuery({
  queryKey: rulesKey,
  queryFn: () => api.groupPersonas(props.spaceId, props.appId),
})
const personaItems = computed(() => props.personas.map((p) => ({ label: p.name, value: p.id })))
// 规则用着的人格删不掉，找不到只会是人格列表还没加载出来
const personaName = (id: string) =>
  props.personasLoaded ? (props.personas.find((p) => p.id === id)?.name ?? id) : '…'

// 选群：按群名或群号到服务端查，输入停下来再查；下拉框打开时才查
const searchTerm = ref('')
const term = useDebounced(searchTerm)
const pickerOpen = ref(false)
const groups = useQuery({
  queryKey: computed(() => ['group-picker', props.spaceId, term.value]),
  queryFn: () => api.subjects(props.spaceId, { kind: 'group', q: term.value || undefined }),
  enabled: computed(() => props.canManage && pickerOpen.value),
})
type GroupItem = { label: string; value: string; description: string }
// 选中的群单独留着：查找词清空后列表换了一页，选中的那个还要显示名字
const picked = ref<GroupItem | null>(null)
const groupItems = computed(() => {
  const taken = new Set(rules.data.value?.rules.map((r) => r.subjectId))
  const found: GroupItem[] = (groups.data.value?.items ?? [])
    .filter((g) => !taken.has(g.id))
    .map((g) => ({
      label: g.displayName,
      value: g.id,
      description: g.identities.map((i) => `${i.platform} ${i.externalId}`).join('、'),
    }))
  return picked.value && !found.some((g) => g.value === picked.value!.value)
    ? [picked.value, ...found]
    : found
})
const newGroup = ref<string | undefined>()
watch(newGroup, (id) => {
  picked.value = id ? (groupItems.value.find((g) => g.value === id) ?? picked.value) : null
})
const newPersona = ref<string | undefined>()

const current = (): GroupPersonaRule[] =>
  (rules.data.value?.rules ?? []).map(({ subjectId, personaId }) => ({ subjectId, personaId }))

const saving = ref(false)
async function save(next: GroupPersonaRule[], done: string): Promise<boolean> {
  const sid = props.spaceId
  const id = props.appId
  const key = ['group-personas', sid, id]
  saving.value = true
  // 先取消还没回来的读取：它读到的是保存之前的规则，后到的话会盖掉保存的结果
  await queryClient.cancelQueries({ queryKey: key })
  try {
    const saved = await api.saveGroupPersonas(sid, id, { rules: next })
    queryClient.setQueryData(key, saved)
    toast.add({ title: done, color: 'success' })
    return true
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
    // 失败多半是手里的规则已经过时（群删掉了、别处改过），重新读一次，下次按新的保存
    void queryClient.invalidateQueries({ queryKey: key })
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
          v-model:open="pickerOpen"
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
