<script setup lang="ts">
import {
  PLAIN_LAYERS,
  URI_PATTERN,
  type ConsoleMemoryView,
  type PlainLayer,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { layerLabels } from '../labels'

const props = defineProps<{ spaceId: string; memory: ConsoleMemoryView }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [memory: ConsoleMemoryView, from: string] }>()
const queryClient = useQueryClient()

const isPlain = (layer: string): layer is PlainLayer =>
  (PLAIN_LAYERS as readonly string[]).includes(layer)
const form = reactive({ uri: '', layer: 'private' as PlainLayer })
const error = ref<string | null>(null)
const saving = ref(false)

// 打开时的那一版：提交带的 id 与版本号、换没换层、要不要提醒都以它为准。
// 弹窗开着时编辑器可能载入了新版本，或换成了删除后在同一个 URI 重建的另一条，不能对着换进来的那条提交
const origin = ref(props.memory)
watch(open, (value) => {
  if (!value) return
  origin.value = props.memory
  form.uri = props.memory.uri
  form.layer = isPlain(props.memory.layer) ? props.memory.layer : 'private'
  error.value = null
})
// 打开之后这条记忆变了：要关掉重新打开，看过新的那一版再操作
const stale = computed(
  () =>
    open.value &&
    (props.memory.id !== origin.value.id || props.memory.version !== origin.value.version),
)

const domain = computed(() => form.uri.split('://')[0] ?? '')
// persona:// 与 app:// 下的层由 URI 决定；对象层与情节层来自对话，不能改层
const namespaced = computed(() => domain.value === 'persona' || domain.value === 'app')
const fromConversation = computed(
  () => origin.value.layer === 'subject' || origin.value.layer === 'episode',
)
const canPickLayer = computed(() => !namespaced.value && !fromConversation.value)
const uriValid = computed(() => URI_PATTERN.test(form.uri))
const layerItems = PLAIN_LAYERS.map((l) => ({ label: layerLabels[l], value: l }))
// 只在真的换层时才带上 layer：从人格或应用的命名空间移出时必须给，普通 domain 之间没改就不带
const newLayer = computed(() =>
  canPickLayer.value && form.layer !== origin.value.layer ? form.layer : null,
)
const changed = computed(() => form.uri !== origin.value.uri || newLayer.value !== null)

// 在共享的层与个人的层之间转换会改变谁看得到它，提醒一句
const personal = (layer: string) => layer === 'owner' || layer === 'private'
const crossing = computed(() => {
  const to = namespaced.value ? domain.value : (newLayer.value ?? origin.value.layer)
  return personal(to) !== personal(origin.value.layer)
})

async function submit() {
  if (!uriValid.value || !changed.value || stale.value) return
  const m = origin.value
  saving.value = true
  error.value = null
  // 带上打开时那一版的 id 与版本号：期间被改过、或删除后在同一个 URI 重建了，返回 409，不会动到别的记忆
  const expected = { expectedId: m.id, expectedVersion: m.version }
  try {
    const result =
      form.uri === m.uri
        ? await api.updateMemory(props.spaceId, { uri: m.uri, ...expected, layer: form.layer })
        : await api.moveMemory(props.spaceId, {
            from: m.uri,
            to: form.uri,
            ...expected,
            ...(newLayer.value ? { layer: newLayer.value } : {}),
          })
    open.value = false
    emit('done', result, m.uri)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '操作失败'
    // 冲突时让编辑器重新读取这条记忆：读到新的版本后上面提示重新打开，不会一直重试一直 409
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({
        queryKey: ['memory', props.spaceId, m.uri],
        exact: true,
      })
    }
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
        <UFormField label="URI" help="修改 URI 即移动；不修改则只改层">
          <UInput v-model="form.uri" class="w-full font-mono" autofocus />
        </UFormField>
        <UFormField
          v-if="canPickLayer"
          label="层"
          :help="
            origin.layer === 'persona' || origin.layer === 'app'
              ? '移出人格或应用的命名空间时，需选择新的层'
              : undefined
          "
        >
          <USelect v-model="form.layer" :items="layerItems" class="w-full" />
        </UFormField>
        <p v-else-if="namespaced" class="text-sm text-muted">
          移到 {{ domain }}:// 下，层由 URI 决定：{{ domain === 'persona' ? '人格层' : '应用层' }}。
        </p>
        <p v-else class="text-sm text-muted">
          {{ layerLabels[origin.layer] }}层的记忆来自对话，只能改 URI，不能改层。
        </p>
        <UAlert
          v-if="crossing"
          color="warning"
          variant="subtle"
          title="可见范围将改变"
          :description="
            personal(origin.layer)
              ? '改为共享层后，空间内其他成员与有权限的应用均可读取。'
              : '改为个人层后，这条记忆仅属于当前账号，其他成员及其应用将无法读取。'
          "
        />
        <UAlert
          v-if="stale"
          color="warning"
          variant="subtle"
          title="这条记忆已更新"
          description="请关闭后重新打开，确认新版本后再操作。"
        />
        <UAlert v-else-if="error" color="error" variant="subtle" :title="error" />
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
          :disabled="!uriValid || !changed || stale"
        >
          确定
        </UButton>
      </div>
    </template>
  </UModal>
</template>
