<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { MemoryView, Sensitivity } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'

const props = defineProps<{ spaceId: string; uri: string }>()
const emit = defineEmits<{ deleted: [uri: string]; createChild: [parentUri: string] }>()
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

// 没有改动时跟上服务器上的新版本；有未保存的改动时保留它们，提示版本已变化，保存时由版本号检查冲突。
// 比表单载入的那一版还旧的数据不理会，例如保存之前发出的重新拉取晚到了
watch(
  () => memory.data.value,
  (m) => {
    if (!m) return
    if (!base.value) load(m)
    else if (m.version >= base.value.version && !dirty.value) load(m)
  },
  { immediate: true },
)

// 有未保存的修改时，切到别的记忆、别的页面或关掉标签页之前先确认
const leaving = ref(false)
function confirmLeave(): boolean {
  return (
    leaving.value ||
    !dirty.value ||
    window.confirm('这条记忆有未保存的修改，离开后会丢失。确定离开吗？')
  )
}
onBeforeRouteUpdate(confirmLeave)
onBeforeRouteLeave(confirmLeave)
function onBeforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault()
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))
const changedElsewhere = computed(
  () => !!memory.data.value && !!base.value && memory.data.value.version !== base.value.version,
)

const permissions = useMemoryPermissions(computed(() => props.spaceId))
const readOnly = computed(() => (base.value ? permissions.readOnlyReason(base.value) : null))
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
      // 带上表单载入时的版本号：别人改过之后返回 409，不会悄悄覆盖
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
    await api.deleteMemory(props.spaceId, props.uri)
    confirmDelete.value = false
    toast.add({ title: '已删除', color: 'success' })
    // 已经删除了，离开时不再提示未保存的修改
    leaving.value = true
    emit('deleted', props.uri)
  } catch (err) {
    failed(err, '删除失败')
  }
}
</script>

<template>
  <div v-if="memory.isPending.value" class="p-4 text-muted">加载中……</div>
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
      :title="`这条记忆在别处被改过（现在是版本 ${memory.data.value?.version}）。保存会提示冲突，可以先复制你的修改，再载入新版本。`"
      :actions="[
        { label: '载入新版本', onClick: () => memory.data.value && load(memory.data.value) },
      ]"
    />
    <div class="flex flex-wrap items-center gap-2">
      <code class="text-sm font-semibold">{{ base.uri }}</code>
      <UBadge variant="subtle">{{ layerLabels[base.layer] }}</UBadge>
      <UBadge :color="sensitivityColors[base.sensitivity]" variant="subtle">
        {{ sensitivityLabels[base.sensitivity] }}
      </UBadge>
      <span class="text-xs text-muted">
        版本 {{ base.version }} · 来源 {{ base.provenance }} · 更新于
        {{ new Date(base.updatedAt).toLocaleString() }}
      </span>
    </div>

    <UAlert v-if="readOnly" color="neutral" variant="subtle" :title="readOnly" />

    <UFormField label="正文" help="写清背景、为什么、在什么条件下适用">
      <UTextarea
        v-model="form.content"
        :rows="14"
        autoresize
        :disabled="!!readOnly"
        class="w-full font-mono"
      />
    </UFormField>
    <UFormField label="Disclosure" help="什么场景下应该想起这条记忆">
      <UInput v-model="form.disclosure" :disabled="!!readOnly" class="w-full" />
    </UFormField>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Priority" help="0 最重要">
        <UInputNumber v-model="form.priority" :min="0" :max="99" :disabled="!!readOnly" />
      </UFormField>
      <UFormField label="敏感级">
        <USelect
          v-model="form.sensitivity"
          :items="sensitivityItems"
          :disabled="!!readOnly"
          class="w-full"
        />
      </UFormField>
    </div>
    <UFormField label="关键词" help="召回时按关键词命中，至少两个字">
      <UInputTags v-model="form.glossary" :disabled="!!readOnly" class="w-full" />
    </UFormField>

    <div class="flex flex-wrap gap-2">
      <UButton
        v-if="!readOnly"
        :icon="icons.save"
        :loading="saving"
        :disabled="!dirty"
        @click="save"
      >
        保存
      </UButton>
      <UButton
        v-if="permissions.canWriteUri(props.uri)"
        :icon="icons.add"
        color="neutral"
        variant="subtle"
        @click="emit('createChild', props.uri)"
      >
        新建子节点
      </UButton>
      <UButton
        v-if="!readOnly"
        :icon="icons.remove"
        color="error"
        variant="ghost"
        class="ml-auto"
        @click="confirmDelete = true"
      >
        删除
      </UButton>
    </div>

    <UModal v-model:open="confirmDelete" title="删除这条记忆？">
      <template #body>
        <p class="text-sm">
          删除 <code>{{ props.uri }}</code
          >。历史事件会保留，它下面的子节点不受影响。
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
