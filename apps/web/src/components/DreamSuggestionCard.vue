<script setup lang="ts">
import type { ApplySuggestionRequest, DreamSuggestionView } from '@kioku/contracts'
import { computed, reactive, ref } from 'vue'

import { collapseUnchanged, diffLines, type DiffRow } from '../diff'
import { icons } from '../icons'
import { dreamKindLabels, entryKindLabels } from '../labels'
import { entryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'

const props = defineProps<{
  suggestion: DreamSuggestionView
  busy: boolean
}>()

const emit = defineEmits<{
  apply: [id: string, body: ApplySuggestionRequest]
  dismiss: [id: string]
}>()

const editing = ref(false)

const baseEntry = computed(() => {
  if (props.suggestion.keepId) {
    return (
      props.suggestion.entries.find((e) => e.id === props.suggestion.keepId) ??
      props.suggestion.entries[0] ??
      null
    )
  }
  return props.suggestion.entries[0] ?? null
})

const draft = reactive({
  title: '',
  content: '',
  disclosure: '',
  topics: [] as string[],
  isPinned: false,
})
const draftScope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })

function openEditor() {
  const s = props.suggestion
  const base = baseEntry.value
  draft.title = s.proposedTitle ?? base?.title ?? ''
  draft.content = s.proposedContent ?? base?.content ?? ''
  draft.disclosure = s.proposedDisclosure ?? base?.disclosure ?? ''
  draft.topics = [...(s.proposedTopics ?? base?.topics ?? [])]
  draft.isPinned = base?.isPinned ?? false
  draftScope.value = {
    envs: [...(s.proposedEnvs ?? base?.envs ?? [])],
    realms: [...(s.proposedRealms ?? base?.realms ?? [])],
    projects: [...(s.proposedProjects ?? base?.projects ?? [])],
    runtimes: [...(s.proposedRuntimes ?? base?.runtimes ?? [])],
  }
  editing.value = true
}

const diffRows = computed<DiffRow[] | null>(() => {
  const s = props.suggestion
  if (!s.proposedContent) return null
  if (s.kind === 'distill_episode') return null
  const before = baseEntry.value?.content ?? ''
  return collapseUnchanged(diffLines(before, s.proposedContent))
})

function applyDirect() {
  emit('apply', props.suggestion.id, {})
}

function applyEdited() {
  const body: ApplySuggestionRequest = {
    ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.content.trim() ? { content: draft.content } : {}),
    disclosure: draft.disclosure.trim() || null,
    topics: draft.topics,
    envs: draftScope.value.envs,
    realms: draftScope.value.realms,
    projects: draftScope.value.projects,
    runtimes: draftScope.value.runtimes,
    isPinned: draft.isPinned,
  }
  emit('apply', props.suggestion.id, body)
}
</script>

<template>
  <article class="card">
    <header class="card-head">
      <div class="flex flex-wrap items-center gap-2">
        <span class="kind-tag">{{ dreamKindLabels[suggestion.kind] }}</span>
        <span v-if="suggestion.proposedTitle" class="text-sm font-semibold">
          {{ suggestion.proposedTitle }}
        </span>
      </div>
      <time
        class="text-xs text-muted"
        :datetime="suggestion.createdAt"
        :title="formatTime(suggestion.createdAt)"
      >
        {{ formatRelative(suggestion.createdAt) }}
      </time>
    </header>

    <p class="card-reason">{{ suggestion.reason }}</p>

    <div v-if="suggestion.entries.length" class="affected">
      <span class="affected-label">涉及记忆</span>
      <ul class="affected-list">
        <li v-for="entry in suggestion.entries" :key="entry.id">
          <RouterLink :to="entryRoute(entry.shortId)" class="text-primary">
            {{ entry.title }}
          </RouterLink>
          <span class="font-mono text-xs text-muted">{{ entry.shortId }}</span>
          <span class="text-xs text-muted">{{ entryKindLabels[entry.kind] }}</span>
          <span v-if="entry.id === suggestion.keepId" class="keep-tag">保留目标</span>
        </li>
      </ul>
    </div>

    <!-- 预览：过时标记以外展示对比或建议正文 -->
    <template v-if="!editing">
      <pre v-if="diffRows" class="diff-box"><template
        v-for="(row, idx) in diffRows"
        :key="idx"
      ><span v-if="row.kind === 'skip'" class="diff-skip">… 省略未改动的 {{ row.count }} 行</span><span v-else class="diff-line" :class="row.kind">{{ row.text }}</span></template></pre>

      <pre v-else-if="suggestion.proposedContent" class="preview-box">{{
        suggestion.proposedContent
      }}</pre>
    </template>

    <!-- 编辑后应用 -->
    <div v-else class="edit-box">
      <div class="grid gap-3 sm:grid-cols-2">
        <UFormField label="标题">
          <UInput v-model="draft.title" class="w-full" />
        </UFormField>
        <UFormField label="主题">
          <UInputTags v-model="draft.topics" placeholder="输入后回车" class="w-full" />
        </UFormField>
      </div>
      <UFormField label="正文">
        <UTextarea v-model="draft.content" :rows="8" autoresize class="w-full font-mono" />
      </UFormField>
      <UFormField label="触发场景（可选）">
        <UInput v-model="draft.disclosure" class="w-full" />
      </UFormField>
      <UFormField label="适用场景">
        <SceneScopePicker v-model="draftScope" />
      </UFormField>
      <USwitch v-model="draft.isPinned" label="设为启动加载" />
    </div>

    <footer class="card-actions">
      <template v-if="!editing">
        <UButton size="sm" :icon="icons.check" :loading="busy" @click="applyDirect">
          {{ suggestion.kind === 'mark_stale' ? '确认移入回收站' : '应用' }}
        </UButton>
        <UButton
          v-if="suggestion.kind !== 'mark_stale'"
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.edit"
          :disabled="busy"
          @click="openEditor"
        >
          编辑后应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="emit('dismiss', suggestion.id)"
        >
          忽略
        </UButton>
      </template>
      <template v-else>
        <UButton
          size="sm"
          :icon="icons.check"
          :loading="busy"
          :disabled="!draft.content.trim()"
          @click="applyEdited"
        >
          保存并应用
        </UButton>
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :disabled="busy"
          @click="editing = false"
        >
          取消编辑
        </UButton>
      </template>
    </footer>
  </article>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.kind-tag {
  padding: 1px 6px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 500;
}
.card-reason {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ui-text);
}
.affected {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-left: 2px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.affected-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.affected-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.affected-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.keep-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.diff-box,
.preview-box {
  max-height: 22rem;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.diff-skip {
  display: block;
  padding-left: 16px;
  color: var(--ui-text-muted);
}
.diff-line {
  position: relative;
  display: block;
  min-height: 1.65em;
  padding-left: 16px;
}
.diff-line::before {
  content: '';
  position: absolute;
  left: 2px;
}
.diff-line.add {
  font-weight: 600;
}
.diff-line.add::before {
  content: '+';
}
.diff-line.remove {
  color: var(--ui-error);
  text-decoration: line-through;
}
.diff-line.remove::before {
  content: '−';
}
.edit-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}
</style>
