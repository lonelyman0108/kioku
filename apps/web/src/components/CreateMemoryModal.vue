<script setup lang="ts">
import { URI_PATTERN, type Layer, type Sensitivity } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { creatableLayers, layerLabels, sensitivityLabels } from '../labels'

const props = defineProps<{ spaceId: string; initialUri: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [uri: string] }>()

const form = reactive({
  uri: '',
  content: '',
  layer: 'private' as Layer,
  // null 表示按层默认；下拉框把 undefined 当成没有选，显示不出「按层默认」
  sensitivity: null as Sensitivity | null,
  disclosure: '',
})
const error = ref<string | null>(null)
const saving = ref(false)

// 手动选过层之后，就不再按 domain 默认层改它
const layerTouched = ref(false)

watch(open, (value) => {
  if (!value) return
  Object.assign(form, {
    uri: props.initialUri,
    content: '',
    layer: 'private',
    sensitivity: null,
    disclosure: '',
  })
  layerTouched.value = false
  error.value = null
})

// persona:// 与 app:// 下的层由 URI 决定，不再让人选
const domain = computed(() => form.uri.split('://')[0] ?? '')
const layerFixed = computed(() => domain.value === 'persona' || domain.value === 'app')

// 空间配置的 domain 默认层：没手动选过层时，按 URI 的 domain 带出，没配置的按私人层
const domainLayers = useQuery({
  queryKey: computed(() => ['domain-layers', props.spaceId]),
  queryFn: () => api.domainLayers(props.spaceId),
})
const suggestedLayer = computed(() => domainLayers.data.value?.defaults[domain.value])
watch(
  [suggestedLayer, open],
  ([suggested, isOpen]) => {
    if (isOpen && !layerTouched.value && !layerFixed.value) form.layer = suggested ?? 'private'
  },
  { immediate: true },
)
const layerHelp = computed(() => {
  if (layerFixed.value) return '由 URI 决定'
  if (suggestedLayer.value && !layerTouched.value) return '按空间设置的 domain 默认层带出'
  return undefined
})
const uriValid = computed(() => URI_PATTERN.test(form.uri))
const layerItems = creatableLayers.map((l) => ({ label: layerLabels[l], value: l }))
// editor 签不了 secret，选项里也不给
const { sensitivities } = useMemoryPermissions(computed(() => props.spaceId))
const sensitivityItems = computed(() => [
  { label: '按层默认', value: null },
  ...sensitivities.value.map((s) => ({ label: sensitivityLabels[s], value: s })),
])

async function submit() {
  saving.value = true
  error.value = null
  try {
    const created = await api.createMemory(props.spaceId, {
      uri: form.uri,
      content: form.content,
      ...(layerFixed.value ? {} : { layer: form.layer }),
      ...(form.sensitivity ? { sensitivity: form.sensitivity } : {}),
      ...(form.disclosure.trim() ? { disclosure: form.disclosure.trim() } : {}),
    })
    open.value = false
    emit('created', created.uri)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '创建失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" title="新建记忆">
    <template #body>
      <form id="create-memory" class="space-y-4" @submit.prevent="submit">
        <UFormField label="URI" help="domain://path，例如 core://agent、projects://kioku">
          <UInput v-model="form.uri" class="w-full font-mono" autofocus />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="层" :help="layerHelp">
            <USelect
              v-model="form.layer"
              :items="layerItems"
              :disabled="layerFixed"
              class="w-full"
              @update:model-value="layerTouched = true"
            />
          </UFormField>
          <UFormField label="敏感级">
            <USelect v-model="form.sensitivity" :items="sensitivityItems" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="正文">
          <UTextarea v-model="form.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <UFormField label="Disclosure" help="什么场景下应该想起这条记忆">
          <UInput v-model="form.disclosure" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton
          type="submit"
          form="create-memory"
          :loading="saving"
          :disabled="!uriValid || !form.content.trim()"
        >
          创建
        </UButton>
      </div>
    </template>
  </UModal>
</template>
