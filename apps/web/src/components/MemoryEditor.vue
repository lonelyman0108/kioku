<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { MemoryView, Sensitivity } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { layerLabels, sensitivityColors, sensitivityLabels } from '../labels'

const props = defineProps<{ spaceId: string; uri: string }>()
const emit = defineEmits<{ deleted: [uri: string]; createChild: [parentUri: string] }>()
const toast = useToast()

const memory = useQuery({
  queryKey: computed(() => ['memory', props.spaceId, props.uri]),
  queryFn: () => api.memory(props.spaceId, props.uri),
})

const form = reactive({
  content: '',
  disclosure: '',
  priority: 2,
  sensitivity: 'private' as Sensitivity,
  glossary: [] as string[],
})

function load(m: MemoryView) {
  form.content = m.content ?? ''
  form.disclosure = m.disclosure ?? ''
  form.priority = m.priority
  form.sensitivity = m.sensitivity
  form.glossary = [...m.glossary]
}
watch(
  () => memory.data.value,
  (m) => m && load(m),
  { immediate: true },
)

const dirty = computed(() => {
  const m = memory.data.value
  if (!m) return false
  return (
    form.content !== (m.content ?? '') ||
    form.disclosure !== (m.disclosure ?? '') ||
    form.priority !== m.priority ||
    form.sensitivity !== m.sensitivity ||
    form.glossary.join('\n') !== m.glossary.join('\n')
  )
})

const permissions = useMemoryPermissions(computed(() => props.spaceId))
const readOnly = computed(() =>
  memory.data.value ? permissions.readOnlyReason(memory.data.value) : null,
)
const sensitivityItems = computed(() =>
  permissions.sensitivities.value.map((s) => ({ label: sensitivityLabels[s], value: s })),
)
const saving = ref(false)
const confirmDelete = ref(false)

function failed(err: unknown, fallback: string) {
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })
}

async function save() {
  const m = memory.data.value
  if (!m) return
  saving.value = true
  try {
    const next = await api.updateMemory(props.spaceId, {
      uri: m.uri,
      // 带上读取时的版本号：别人刚改过时返回 409，不会悄悄覆盖
      expectedVersion: m.version,
      ...(form.content !== (m.content ?? '') ? { content: form.content } : {}),
      disclosure: form.disclosure.trim() ? form.disclosure.trim() : null,
      priority: form.priority,
      sensitivity: form.sensitivity,
      glossaryAdd: form.glossary.filter((k) => !m.glossary.includes(k)),
      glossaryRemove: m.glossary.filter((k) => !form.glossary.includes(k)),
    })
    memory.refetch()
    load(next)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    failed(err, '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove() {
  try {
    await api.deleteMemory(props.spaceId, props.uri)
    confirmDelete.value = false
    toast.add({ title: '已删除', color: 'success' })
    emit('deleted', props.uri)
  } catch (err) {
    failed(err, '删除失败')
  }
}
</script>

<template>
  <div v-if="memory.isPending.value" class="p-4 text-muted">加载中……</div>
  <UAlert
    v-else-if="memory.isError.value"
    color="error"
    variant="subtle"
    :title="memory.error.value instanceof ApiError ? memory.error.value.message : '读取失败'"
  />
  <div v-else-if="memory.data.value" class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <code class="text-sm font-semibold">{{ memory.data.value.uri }}</code>
      <UBadge variant="subtle">{{ layerLabels[memory.data.value.layer] }}</UBadge>
      <UBadge :color="sensitivityColors[memory.data.value.sensitivity]" variant="subtle">
        {{ sensitivityLabels[memory.data.value.sensitivity] }}
      </UBadge>
      <span class="text-xs text-muted">
        版本 {{ memory.data.value.version }} · 来源 {{ memory.data.value.provenance }} · 更新于
        {{ new Date(memory.data.value.updatedAt).toLocaleString() }}
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
