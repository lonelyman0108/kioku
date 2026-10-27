<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import type { MemoryView, Sensitivity } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { hasUnsavedChanges, useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { icons } from '../icons'
import { buildKeywordIndex } from '../keywords'
import { layerLabels, provenanceLabels, sensitivityColors, sensitivityLabels } from '../labels'
import { formatRelative, formatTime } from '../time'
import MemoryContent from './MemoryContent.vue'
import MemoryHistory from './MemoryHistory.vue'
import MoveMemoryModal from './MoveMemoryModal.vue'

const props = defineProps<{ spaceId: string; uri: string }>()
const emit = defineEmits<{
  deleted: [uri: string]
  createChild: [parentUri: string]
  moved: [memory: MemoryView, from: string]
  // 保存或恢复了旧版本：层、敏感级、priority、disclosure 可能变了
  changed: [memory: MemoryView]
  open: [uri: string]
}>()
const toast = useToast()
const queryClient = useQueryClient()

const queryKey = computed(() => ['memory', props.spaceId, props.uri])
const memory = useQuery({
  queryKey,
  queryFn: () => api.memory(props.spaceId, props.uri),
})

const form = reactive({
  content: '',
  disclosure: '',
  priority: 2,
  sensitivity: 'private' as Sensitivity,
  glossary: [] as string[],
})

// 表单是从哪一版载入的：改动与保存时的版本号都以它为准，而不是缓存里最新的那份。
// 否则后台重新拉取到别人改过的新版本，会悄悄覆盖还没保存的修改，或者让保存绕过冲突检查
const base = ref<MemoryView | null>(null)

function load(m: MemoryView) {
  base.value = m
  form.content = m.content ?? ''
  form.disclosure = m.disclosure ?? ''
  form.priority = m.priority
  form.sensitivity = m.sensitivity
  form.glossary = [...m.glossary]
}

const dirty = computed(() => {
  const m = base.value
  if (!m) return false
  return (
    form.content !== (m.content ?? '') ||
    form.disclosure !== (m.disclosure ?? '') ||
    form.priority !== m.priority ||
    form.sensitivity !== m.sensitivity ||
    form.glossary.join('\n') !== m.glossary.join('\n')
  )
})

// 有未保存的改动时保留它们，提示在别处被改过，保存时由 id 与版本号检查冲突。
// 没有改动时跟上服务器：换成了另一条（删除后在同一个 URI 重建），或者有了更新的版本；
// 同一条但比表单那一版还旧的数据不理会，例如保存之前发出的重新拉取晚到了
watch(
  () => memory.data.value,
  (m) => {
    if (!m) return
    if (!base.value) return load(m)
    if (dirty.value) return
    if (m.id !== base.value.id || m.version >= base.value.version) adopt(m)
  },
  { immediate: true },
)

// 载入服务器上的一版；比表单那一版新时通知页面，树上的标记与列表跟着变（别处改过、或从历史里恢复了）
function adopt(m: MemoryView) {
  const b = base.value
  const newer = !!b && (m.id !== b.id || m.version > b.version)
  load(m)
  if (newer) emit('changed', m)
}

// 服务器上最新的那一版。表单有改动时上面的监听会跳过新版本，开始或取消编辑时要从它载入
function latest(): MemoryView | null {
  const [m, b] = [memory.data.value, base.value]
  if (!m || !b) return m ?? b
  return m.id !== b.id || m.version >= b.version ? m : b
}

// 有未保存的修改时，切到别的记忆、别的页面、退出登录或关掉标签页之前先确认（见 unsavedChanges.ts）。
// 换视图或筛选条件时编辑器还在，不用确认
const { leaving } = useUnsavedChangesGuard(dirty, {
  leavesOn: (to, from) =>
    to.query.uri !== from.query.uri || to.params.spaceId !== from.params.spaceId,
})
const changedElsewhere = computed(() => {
  const [m, b] = [memory.data.value, base.value]
  return !!m && !!b && (m.id !== b.id || m.version !== b.version)
})

const permissions = useMemoryPermissions(computed(() => props.spaceId))
const readOnly = computed(() => (base.value ? permissions.readOnlyReason(base.value) : null))

// 默认是阅读状态，点「编辑」才改原文
const mode = ref<'read' | 'edit'>('read')
const preview = ref(false)
function startEditing() {
  const m = latest()
  if (m) adopt(m)
  mode.value = 'edit'
}
function cancelEditing() {
  if (dirty.value && !window.confirm('放弃没保存的修改？')) return
  const m = latest()
  if (m) adopt(m)
  mode.value = 'read'
}

// 正文里出现别的记忆的关键词时标出来，点了过去
const glossary = useQuery({
  queryKey: computed(() => ['memory-glossary', props.spaceId]),
  queryFn: () => api.glossaryIndex(props.spaceId),
  staleTime: 60_000,
})
const keywordIndex = computed(() =>
  glossary.data.value ? buildKeywordIndex(glossary.data.value.entries) : null,
)

const historyOpen = ref(false)
const moveOpen = ref(false)
// 移动或改层之后把结果写进缓存：只改层时编辑器跟上新的层，移动后打开新 URI 时不用再读一次
async function onMoved(next: MemoryView, from: string) {
  const key = ['memory', props.spaceId, next.uri]
  // 先取消进行中的重新拉取，免得晚到的旧数据盖掉移动的结果
  await queryClient.cancelQueries({ queryKey: key, exact: true })
  queryClient.setQueryData(key, next)
  void queryClient.invalidateQueries({ queryKey: ['memory-history', props.spaceId, next.id] })
  emit('moved', next, from)
}

const menu = computed<DropdownMenuItem[][]>(() => {
  const writable = !readOnly.value
  const items: DropdownMenuItem[] = []
  if (writable) {
    items.push({ label: '移动或改层', icon: icons.move, onSelect: () => (moveOpen.value = true) })
  }
  if (permissions.canWriteUri(props.uri)) {
    items.push({
      label: '新建子节点',
      icon: icons.add,
      onSelect: () => emit('createChild', props.uri),
    })
  }
  const danger: DropdownMenuItem[] = writable
    ? [
        {
          label: '删除',
          icon: icons.remove,
          color: 'error',
          onSelect: () => (confirmDelete.value = true),
        },
      ]
    : []
  return [items, danger].filter((group) => group.length)
})
const sensitivityItems = computed(() =>
  permissions.sensitivities.value.map((s) => ({ label: sensitivityLabels[s], value: s })),
)
const saving = ref(false)
const confirmDelete = ref(false)

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

async function save() {
  const m = base.value
  if (!m) return
  saving.value = true
  // 记下这次提交的值：请求期间又改过的字段，保存之后保留新改的内容
  const sent = { ...form, glossary: [...form.glossary] }
  try {
    const next = await api.updateMemory(props.spaceId, {
      uri: m.uri,
      // 带上表单载入时的 id 与版本号：别人改过、或删除后重建了之后返回 409，不会悄悄覆盖
      expectedId: m.id,
      expectedVersion: m.version,
      ...(sent.content !== (m.content ?? '') ? { content: sent.content } : {}),
      disclosure: sent.disclosure.trim() ? sent.disclosure.trim() : null,
      priority: sent.priority,
      sensitivity: sent.sensitivity,
      glossaryAdd: sent.glossary.filter((k) => !m.glossary.includes(k)),
      glossaryRemove: m.glossary.filter((k) => !sent.glossary.includes(k)),
    })
    // 正在进行的重新拉取可能带回保存之前的版本，先取消，再把保存结果写进缓存
    await queryClient.cancelQueries({ queryKey: queryKey.value })
    queryClient.setQueryData(queryKey.value, next)
    base.value = next
    if (form.content === sent.content) form.content = next.content ?? ''
    if (form.disclosure === sent.disclosure) form.disclosure = next.disclosure ?? ''
    if (form.priority === sent.priority) form.priority = next.priority
    if (form.sensitivity === sent.sensitivity) form.sensitivity = next.sensitivity
    if (form.glossary.join('\n') === sent.glossary.join('\n')) form.glossary = [...next.glossary]
    toast.add({ title: '已保存', color: 'success' })
    // 保存期间没有再改，就回到阅读状态
    if (!dirty.value) mode.value = 'read'
    void queryClient.invalidateQueries({ queryKey: ['memory-history', props.spaceId, next.id] })
    emit('changed', next)
  } catch (err) {
    failed(err, '保存失败')
    // 版本冲突时立刻重新拉取，好显示「载入新版本」
    if (err instanceof ApiError && err.status === 409) void memory.refetch()
  } finally {
    saving.value = false
  }
}

async function remove() {
  try {
    // 带上表单载入时的 id 与版本号：期间被改过、或删除后重建了的记忆不会被一起删掉
    if (!base.value) return
    await api.deleteMemory(props.spaceId, props.uri, base.value)
    confirmDelete.value = false
    toast.add({ title: '已删除', color: 'success' })
    // 已经删除了，离开时不再提示未保存的修改
    leaving.value = true
    hasUnsavedChanges.value = false
    emit('deleted', props.uri)
  } catch (err) {
    failed(err, '删除失败')
  }
}
</script>

<template>
  <div v-if="memory.isPending.value" class="space-y-3 p-1">
    <USkeleton class="h-6 w-1/2" />
    <USkeleton class="h-40 w-full" />
  </div>
  <UAlert
    v-else-if="!base"
    color="error"
    variant="subtle"
    :title="memory.error.value instanceof ApiError ? memory.error.value.message : '读取失败'"
  />
  <div v-else class="space-y-4">
    <!-- 已经载入过时，重新拉取失败（例如别处删除了它）也保留表单，免得丢掉正在编辑的内容 -->
    <UAlert
      v-if="memory.isError.value"
      color="warning"
      variant="subtle"
      :title="`刷新失败：${memory.error.value instanceof ApiError ? memory.error.value.message : '读取失败'}`"
    />
    <UAlert
      v-else-if="changedElsewhere && dirty"
      color="warning"
      variant="subtle"
      title="这条记忆在别处被改过，或被删除后重新创建了。保存会提示冲突，可以先复制你的修改，再载入新版本。"
      :actions="[
        { label: '载入新版本', onClick: () => memory.data.value && adopt(memory.data.value) },
      ]"
    />

    <!-- 标题行：URI、层、敏感级与操作 -->
    <div class="flex flex-wrap items-center gap-2">
      <code class="text-sm font-semibold">{{ base.uri }}</code>
      <UBadge variant="subtle" color="neutral">{{ layerLabels[base.layer] }}</UBadge>
      <UBadge :color="sensitivityColors[base.sensitivity]" variant="subtle">
        {{ sensitivityLabels[base.sensitivity] }}
      </UBadge>
      <UBadge variant="outline" color="neutral">priority {{ base.priority }}</UBadge>
      <div class="ml-auto flex items-center gap-1">
        <template v-if="mode === 'read'">
          <UButton v-if="!readOnly" :icon="icons.edit" size="sm" @click="startEditing">
            编辑
          </UButton>
          <UButton
            :icon="icons.activity"
            size="sm"
            color="neutral"
            variant="ghost"
            @click="historyOpen = true"
          >
            历史
          </UButton>
          <UDropdownMenu v-if="menu.length" :items="menu" :content="{ align: 'end' }">
            <UButton
              :icon="icons.more"
              size="sm"
              color="neutral"
              variant="ghost"
              aria-label="更多操作"
            />
          </UDropdownMenu>
        </template>
        <template v-else>
          <!-- 不放进表单字段里：表单字段会把自己的标签给里面的第一个控件 -->
          <USwitch v-model="preview" size="sm" label="预览" class="me-2" />
          <UButton
            :icon="icons.save"
            size="sm"
            :loading="saving"
            :disabled="!dirty || !form.content.trim()"
            @click="save"
          >
            保存
          </UButton>
          <UButton size="sm" color="neutral" variant="ghost" @click="cancelEditing">取消</UButton>
        </template>
      </div>
    </div>

    <UAlert v-if="readOnly" color="neutral" variant="subtle" :title="readOnly" />

    <!-- 阅读：disclosure、关键词、渲染后的正文与来历 -->
    <template v-if="mode === 'read'">
      <div v-if="base.disclosure?.trim() || base.glossary.length" class="space-y-2">
        <blockquote
          v-if="base.disclosure?.trim()"
          class="border-l-2 border-accented pl-3 text-sm text-muted"
        >
          <span class="text-xs text-dimmed">什么时候想起：</span>{{ base.disclosure }}
        </blockquote>
        <div v-if="base.glossary.length" class="flex flex-wrap items-center gap-1.5">
          <span class="text-xs text-dimmed">关键词</span>
          <UBadge
            v-for="keyword in base.glossary"
            :key="keyword"
            size="sm"
            variant="outline"
            color="neutral"
          >
            {{ keyword }}
          </UBadge>
        </div>
      </div>
      <p v-if="!base.disclosure?.trim()" class="text-xs text-warning">
        没写 disclosure：写清什么场景下该想起它，召回时多一条线索。
      </p>
      <div class="rounded-lg border border-default p-4">
        <MemoryContent
          v-if="base.content !== null"
          :content="base.content"
          :keywords="keywordIndex"
          :self="base.uri"
          @open="(uri) => emit('open', uri)"
        />
        <p v-else class="text-sm text-muted">secret 的正文只有能读 secret 的成员看得到。</p>
      </div>
      <p class="text-xs text-muted">
        版本 {{ base.version }} · 来源 {{ provenanceLabels[base.provenance] }}
        <template v-if="base.originScope !== 'global'"> · 来自 {{ base.originScope }}</template>
        · 创建于
        <time :datetime="base.createdAt" :title="formatTime(base.createdAt)">
          {{ formatRelative(base.createdAt) }}
        </time>
        · 更新于
        <time :datetime="base.updatedAt" :title="formatTime(base.updatedAt)">
          {{ formatRelative(base.updatedAt) }}
        </time>
        <template v-if="base.validTo"> · 有效到 {{ formatTime(base.validTo) }}</template>
      </p>
    </template>

    <!-- 编辑：改原文，可以并排预览 -->
    <template v-else>
      <UFormField label="正文" help="写清背景、为什么、在什么条件下适用；Markdown">
        <div class="grid gap-3" :class="preview ? 'lg:grid-cols-2' : ''">
          <UTextarea
            v-model="form.content"
            :rows="18"
            autoresize
            :maxrows="40"
            class="w-full font-mono"
          />
          <div v-if="preview" class="overflow-auto rounded-lg border border-default p-4">
            <MemoryContent :content="form.content" />
          </div>
        </div>
      </UFormField>
      <UFormField label="Disclosure" help="什么场景下应该想起这条记忆">
        <UInput v-model="form.disclosure" class="w-full" />
      </UFormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Priority" help="0 最重要">
          <UInputNumber v-model="form.priority" :min="0" :max="99" />
        </UFormField>
        <UFormField label="敏感级">
          <USelect v-model="form.sensitivity" :items="sensitivityItems" class="w-full" />
        </UFormField>
      </div>
      <UFormField label="关键词" help="召回时按关键词命中，至少两个字">
        <UInputTags v-model="form.glossary" class="w-full" />
      </UFormField>
    </template>

    <USlideover v-model:open="historyOpen" title="历史" :ui="{ content: 'max-w-2xl' }">
      <template #body>
        <MemoryHistory
          v-if="historyOpen"
          :space-id="spaceId"
          :memory-id="base.id"
          :can-restore="!readOnly && mode === 'read'"
        />
      </template>
    </USlideover>

    <MoveMemoryModal v-model:open="moveOpen" :space-id="spaceId" :memory="base" @done="onMoved" />

    <UModal v-model:open="confirmDelete" title="删除这条记忆？">
      <template #body>
        <p class="text-sm">
          删除 <code>{{ props.uri }}</code
          >。历史事件会保留，之后可以在「已删除」里撤销删除；它下面的子节点不受影响。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmDelete = false">取消</UButton>
          <UButton color="error" @click="remove">删除</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
