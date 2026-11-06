<script setup lang="ts">
import { URI_PATTERN, type ConsoleMemoryView } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { layerOfUri } from '../coordinates'
import { layerLabels } from '../labels'
import NoteLine from './strata/NoteLine.vue'

const props = defineProps<{ spaceId: string; memory: ConsoleMemoryView }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [memory: ConsoleMemoryView, from: string] }>()
const queryClient = useQueryClient()

const form = reactive({ uri: '' })
const error = ref<string | null>(null)
const saving = ref(false)

// 打开时的那一版：提交带的 id 与版本号、换没换层、要不要提醒都以它为准。
// 弹窗开着时编辑器可能载入了新版本，或换成了删除后在同一个 URI 重建的另一条，不能对着换进来的那条提交
const origin = ref(props.memory)
watch(open, (value) => {
  if (!value) return
  origin.value = props.memory
  form.uri = props.memory.uri
  error.value = null
})
// 打开之后这条记忆变了：要关掉重新打开，看过新的那一版再操作
const stale = computed(
  () =>
    open.value &&
    (props.memory.id !== origin.value.id || props.memory.version !== origin.value.version),
)

// 归属由坐标的开头决定
const newLayer = computed(() => layerOfUri(form.uri))
const uriValid = computed(() => URI_PATTERN.test(form.uri))
const changed = computed(() => form.uri !== origin.value.uri)

// 在共享的归属与本人之间转换会改变谁看得到它，提醒一句
const personal = (layer: string | null) => layer === 'user'
const crossing = computed(
  () => !!newLayer.value && personal(newLayer.value) !== personal(origin.value.layer),
)

async function submit() {
  if (!uriValid.value || !changed.value || stale.value) return
  const m = origin.value
  saving.value = true
  error.value = null
  // 带上打开时那一版的 id 与版本号：期间被改过、或删除后在同一个 URI 重建了，返回 409，不会动到别的记忆
  const expected = { expectedId: m.id, expectedVersion: m.version }
  try {
    const result = await api.moveMemory(props.spaceId, { from: m.uri, to: form.uri, ...expected })
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
      <!-- 不用 form：单选在表单里时回车会隐式提交，还没看见「可见范围将改变」就移动了。只有点确定才提交 -->
      <div class="space-y-4">
        <UFormField label="URI" help="修改 URI 即移动；不修改则只改层">
          <UInput v-model="form.uri" class="w-full font-mono" autofocus />
        </UFormField>
        <p v-if="newLayer" class="text-sm text-muted">{{ layerLabels[newLayer] }}</p>
        <NoteLine v-if="crossing" tone="warning">
          可见范围将改变
          <template #detail>
            {{
              personal(origin.layer)
                ? '改为共享层后，空间内其他成员与有权限的应用均可读取。'
                : '改为个人层后，这条记忆仅属于当前账号，其他成员及其应用将无法读取。'
            }}
          </template>
        </NoteLine>
        <NoteLine v-if="stale" tone="warning">
          这条记忆已更新
          <template #detail>请关闭后重新打开，确认新版本后再操作。</template>
        </NoteLine>
        <NoteLine v-else-if="error" tone="error">{{ error }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :loading="saving" :disabled="!uriValid || !changed || stale" @click="submit">
          确定
        </UButton>
      </div>
    </template>
  </UModal>
</template>
