<script setup lang="ts">
import { PLAIN_LAYERS, URI_PATTERN, type MemoryView, type PlainLayer } from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { layerLabels } from '../labels'

const props = defineProps<{ spaceId: string; memory: MemoryView }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [memory: MemoryView, from: string] }>()

const isPlain = (layer: string): layer is PlainLayer =>
  (PLAIN_LAYERS as readonly string[]).includes(layer)
const form = reactive({ uri: '', layer: 'private' as PlainLayer })
const error = ref<string | null>(null)
const saving = ref(false)

watch(open, (value) => {
  if (!value) return
  form.uri = props.memory.uri
  form.layer = isPlain(props.memory.layer) ? props.memory.layer : 'private'
  error.value = null
})

const domain = computed(() => form.uri.split('://')[0] ?? '')
// persona:// 与 app:// 下的层由 URI 决定；对象层与情节层来自对话，不能改层
const namespaced = computed(() => domain.value === 'persona' || domain.value === 'app')
const fromConversation = computed(
  () => props.memory.layer === 'subject' || props.memory.layer === 'episode',
)
const canPickLayer = computed(() => !namespaced.value && !fromConversation.value)
const uriValid = computed(() => URI_PATTERN.test(form.uri))
const layerItems = PLAIN_LAYERS.map((l) => ({ label: layerLabels[l], value: l }))
// 只在真的换层时才带上 layer：从人格或应用的命名空间移出时必须给，普通 domain 之间没改就不带
const newLayer = computed(() =>
  canPickLayer.value && form.layer !== props.memory.layer ? form.layer : null,
)
const changed = computed(() => form.uri !== props.memory.uri || newLayer.value !== null)

// 在共享的层与个人的层之间转换会改变谁看得到它，提醒一句
const personal = (layer: string) => layer === 'owner' || layer === 'private'
const crossing = computed(() => {
  const to = namespaced.value ? domain.value : (newLayer.value ?? props.memory.layer)
  return personal(to) !== personal(props.memory.layer)
})

async function submit() {
  if (!uriValid.value || !changed.value) return
  saving.value = true
  error.value = null
  // 带上打开时那一版的 id 与版本号：期间被改过、或删除后在同一个 URI 重建了，返回 409，不会动到别的记忆
  const expected = { expectedId: props.memory.id, expectedVersion: props.memory.version }
  try {
    const result =
      form.uri === props.memory.uri
        ? await api.updateMemory(props.spaceId, {
            uri: props.memory.uri,
            ...expected,
            layer: form.layer,
          })
        : await api.moveMemory(props.spaceId, {
            from: props.memory.uri,
            to: form.uri,
            ...expected,
            ...(newLayer.value ? { layer: newLayer.value } : {}),
          })
    open.value = false
    emit('done', result, props.memory.uri)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 请求期间不能关掉，否则失败的提示没地方显示 -->
  <UModal v-model:open="open" title="移动或改层" :dismissible="!saving" :close="!saving">
    <template #body>
      <form id="move-memory" class="space-y-4" @submit.prevent="submit">
        <UFormField label="URI" help="改了就是移动；不改只改层">
          <UInput v-model="form.uri" class="w-full font-mono" autofocus />
        </UFormField>
        <UFormField
          v-if="canPickLayer"
          label="层"
          :help="
            memory.layer === 'persona' || memory.layer === 'app'
              ? '移出人格或应用的命名空间，要选新的层'
              : undefined
          "
        >
          <USelect v-model="form.layer" :items="layerItems" class="w-full" />
        </UFormField>
        <p v-else-if="namespaced" class="text-sm text-muted">
          移到 {{ domain }}:// 下，层由 URI 决定：{{ domain === 'persona' ? '人格层' : '应用层' }}。
        </p>
        <p v-else class="text-sm text-muted">
          {{ layerLabels[memory.layer] }}层的记忆来自对话，只能改 URI，不能改层。
        </p>
        <UAlert
          v-if="crossing"
          color="warning"
          variant="subtle"
          title="这会改变谁看得到它"
          :description="
            personal(memory.layer)
              ? '改成共享的层之后，空间里的其他成员与有权限的应用都能读到它。'
              : '改成个人的层之后，它只属于你，其他成员与别人的应用就看不到了。'
          "
        />
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton
          type="submit"
          form="move-memory"
          :loading="saving"
          :disabled="!uriValid || !changed"
        >
          确定
        </UButton>
      </div>
    </template>
  </UModal>
</template>
