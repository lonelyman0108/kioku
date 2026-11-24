<script setup lang="ts">
import type { PersonaInfo } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import PersonaFormModal from '../components/PersonaFormModal.vue'
import PersonaPanel from '../components/PersonaPanel.vue'
import { guideLines } from '../components/memoryTree'
import EmptyState from '../components/strata/EmptyState.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { personaRows } from '../personas'

// 独立人格页：管理本记忆圈的人格继承树与各设定段覆盖，优先于记忆在启动加载顶部注入
const route = useRoute()
const router = useRouter()

const circleId = computed(() => String(route.params.circleId))
const { canEditPersonas } = useMemoryPermissions(circleId)

const personasQuery = useQuery({
  queryKey: computed(() => ['personas', circleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.personas(cid),
})
const clientsQuery = useQuery({
  queryKey: computed(() => ['clients', circleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.clients(cid),
})
const personas = computed(() => personasQuery.data.value ?? [])
const rows = computed(() => personaRows(personas.value))

const defaultClientCounts = computed(() => {
  const counts = new Map<string, number>()
  for (const client of clientsQuery.data.value ?? []) {
    if (!client.defaultPersonaId) continue
    counts.set(client.defaultPersonaId, (counts.get(client.defaultPersonaId) ?? 0) + 1)
  }
  return counts
})

const selectedPersonaId = computed(() => {
  const fromQuery = typeof route.query.persona === 'string' ? route.query.persona : ''
  if (fromQuery && personas.value.some((p) => p.id === fromQuery)) return fromQuery
  return personas.value[0]?.id ?? ''
})

const panelRef = ref<InstanceType<typeof PersonaPanel> | null>(null)

function selectPersona(id: string) {
  void router.replace({ query: { persona: id } })
  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023.98px)').matches) {
    void nextTick(() => panelRef.value?.focusTitle())
  }
}

const personaFormOpen = ref(false)
const editingPersona = ref<PersonaInfo | null>(null)
const initialParentId = ref<string | null>(null)

function openCreatePersona() {
  editingPersona.value = null
  initialParentId.value = null
  personaFormOpen.value = true
}

function openCreateChild(parentId: string) {
  editingPersona.value = null
  initialParentId.value = parentId
  personaFormOpen.value = true
}

function openEditPersona(p: PersonaInfo) {
  editingPersona.value = p
  initialParentId.value = null
  personaFormOpen.value = true
}

function onPersonaSaved(saved: PersonaInfo, created: boolean) {
  if (created || selectedPersonaId.value === saved.id) selectPersona(saved.id)
}

function onPersonaRemoved() {
  const remaining = personas.value.filter((p) => p.id !== selectedPersonaId.value)
  if (remaining.length) selectPersona(remaining[0]!.id)
  else void router.replace({ query: {} })
}
</script>

<template>
  <div class="personas-page">
    <header class="personas-head">
      <div class="head-title">
        <h1>人格</h1>
        <Hint>
          人格独立于记忆目录，负责 AI
          的灵魂、口吻与行事约定。子人格沿继承链沿用父人格设定，覆盖同键设定时启动加载只注入覆盖后的结果，并置于启动加载顶部。
        </Hint>
      </div>
      <div v-if="canEditPersonas" class="head-actions">
        <UButton size="sm" :icon="icons.add" @click="openCreatePersona">新建人格</UButton>
      </div>
    </header>

    <div class="personas-body">
      <div v-if="personasQuery.isError.value" class="p-6">
        <ReadFailureNote :query="personasQuery" />
      </div>
      <div v-if="personasQuery.isPending.value" class="p-6 space-y-3">
        <USkeleton class="h-12 w-full" />
        <USkeleton class="h-48 w-full" />
      </div>
      <EmptyState
        v-else-if="personasQuery.data.value && !personas.length"
        title="暂无人格"
        description="新建人格后，可配置可沿用与覆盖的设定段，并绑定到客户端、群聊规则或访问密钥。"
      >
        <template v-if="canEditPersonas" #actions>
          <UButton @click="openCreatePersona">新建人格</UButton>
        </template>
      </EmptyState>
      <div v-else-if="personasQuery.data.value" class="split-layout">
        <aside class="side-list" aria-label="人格继承树">
          <ul>
            <li v-for="row in rows" :key="row.persona.id">
              <button
                type="button"
                class="persona-row"
                :class="{ selected: row.persona.id === selectedPersonaId }"
                :style="{ paddingLeft: `${14 + row.depth * 16}px` }"
                @click="selectPersona(row.persona.id)"
              >
                <span
                  v-for="(line, i) in guideLines(row)"
                  :key="i"
                  class="guide"
                  :class="{ end: line.end, tick: line.tick }"
                  :style="{ left: `${line.left}px` }"
                  aria-hidden="true"
                />
                <StrataSwatch band="persona" plain decorative />
                <span class="persona-name" :title="row.persona.name">{{ row.persona.name }}</span>
                <span
                  v-if="defaultClientCounts.get(row.persona.id)"
                  class="persona-used tabular-nums"
                  :title="`${defaultClientCounts.get(row.persona.id)} 个客户端设为默认人格`"
                >
                  {{ defaultClientCounts.get(row.persona.id) }} 客户端
                </span>
                <span
                  v-if="row.persona.groupRuleCount"
                  class="persona-used tabular-nums"
                  :title="`${row.persona.groupRuleCount} 条按群规则使用此人格`"
                >
                  {{ row.persona.groupRuleCount }} 群
                </span>
                <code class="persona-slug">{{ row.persona.slug }}</code>
              </button>
            </li>
          </ul>
        </aside>

        <div class="persona-pane">
          <PersonaPanel
            v-if="selectedPersonaId"
            ref="panelRef"
            :circle-id="circleId"
            :persona-id="selectedPersonaId"
            :personas="personas"
            :can-edit="canEditPersonas"
            @edit="openEditPersona"
            @create-child="openCreateChild"
            @removed="onPersonaRemoved"
            @open="selectPersona"
          />
        </div>
      </div>
    </div>
  </div>

  <PersonaFormModal
    v-model:open="personaFormOpen"
    :circle-id="circleId"
    :personas="personas"
    :editing="editingPersona"
    :initial-parent-id="initialParentId"
    @saved="onPersonaSaved"
  />
</template>

<style scoped>
.personas-page {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.personas-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 0 16px;
  border-bottom: 1px solid var(--strata-rule);
}
.head-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.head-title h1 {
  font-size: 15px;
  font-weight: 600;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.personas-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.split-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
}
.side-list {
  overflow-y: auto;
  border-right: 1px solid var(--strata-rule);
}
.persona-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.persona-row:hover {
  background: var(--ui-bg-elevated);
}
.persona-row.selected {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.persona-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.persona-used {
  font-size: 12px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.persona-slug {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.persona-row.selected .persona-used,
.persona-row.selected .persona-slug {
  color: var(--strata-on-selected-muted);
}
.persona-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-border);
}
.guide.end {
  bottom: 50%;
}
.guide.tick::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 7px;
  height: 1px;
  background: var(--ui-border);
}

@media (max-width: 1023.98px) {
  .split-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .side-list {
    max-height: 220px;
    border-right: 0;
    border-bottom: 1px solid var(--strata-rule);
  }
}
</style>
