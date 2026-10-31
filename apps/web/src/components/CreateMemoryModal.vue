<script setup lang="ts">
import { PLAINTEXT_CREDENTIAL, URI_PATTERN, type Layer, type Sensitivity } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { creatableLayers, layerLabels, sensitivityLabels } from '../labels'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SwatchOptions from './strata/SwatchOptions.vue'

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
  // 有效到，datetime-local 输入框的本地时间；空表示一直有效
  validTo: '',
})
const error = ref<string | null>(null)
const saving = ref(false)
// 有效到最早能选的时间（见 earliestValidTo）：打开、聚焦选择器与提交之前重新算
const minValidTo = ref('')

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
    validTo: '',
  })
  minValidTo.value = earliestValidTo()
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
  if (layerFixed.value) return undefined
  if (suggestedLayer.value && !layerTouched.value) return '来自空间设置的 domain 默认层'
  return undefined
})
const uriValid = computed(() => URI_PATTERN.test(form.uri))
// 正文像有明文密码或 Token 时提醒换成凭据占位符；只是提醒，照样能创建
const looksPlaintext = computed(() => PLAINTEXT_CREDENTIAL.test(form.content))
// 色块跟着另一个选项走：选了什么就看到什么样子。敏感级按层默认时，层的色块不带纹理
const layerOptions = computed(() =>
  creatableLayers.map((value) => ({
    value,
    label: layerLabels[value],
    layer: value,
    sensitivity: form.sensitivity,
    plain: !form.sensitivity,
  })),
)
// editor 签不了 secret，选项里也不给
const { sensitivities } = useMemoryPermissions(computed(() => props.spaceId))
// persona:// 与 app:// 下选不了层，色块按 URI 决定的层画
const shownLayer = computed<Layer>(() =>
  layerFixed.value ? (domain.value === 'persona' ? 'persona' : 'app') : form.layer,
)
const sensitivityOptions = computed<
  {
    value: Sensitivity | null
    label: string
    layer?: Layer
    sensitivity?: Sensitivity
    bare?: boolean
  }[]
>(() => [
  { value: null, label: '按层默认', bare: true },
  ...sensitivities.value.map((value) => ({
    value,
    label: sensitivityLabels[value],
    layer: shownLayer.value,
    sensitivity: value,
  })),
])

async function submit() {
  const validTo = form.validTo ? fromLocalInput(form.validTo) : null
  if (form.validTo && !validTo) {
    error.value = '有效期的日期和时间不完整'
    return
  }
  // 表单开得久了，当时能选的最早时间现在可能已经太近
  if (validTo && validToTooSoon(form.validTo)) {
    minValidTo.value = earliestValidTo()
    error.value = '有效期须晚于当前时间至少一分钟'
    return
  }
  saving.value = true
  error.value = null
  try {
    const created = await api.createMemory(props.spaceId, {
      uri: form.uri,
      content: form.content,
      ...(layerFixed.value ? {} : { layer: form.layer }),
      ...(form.sensitivity ? { sensitivity: form.sensitivity } : {}),
      ...(form.disclosure.trim() ? { disclosure: form.disclosure.trim() } : {}),
      ...(validTo ? { validTo } : {}),
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
        <UFormField label="层" :help="layerHelp">
          <p v-if="layerFixed" class="text-sm text-muted">由 URI 决定</p>
          <SwatchOptions
            v-else
            v-model="form.layer"
            label="层"
            :options="layerOptions"
            @update:model-value="layerTouched = true"
          />
        </UFormField>
        <UFormField label="敏感级">
          <SwatchOptions v-model="form.sensitivity" label="敏感级" :options="sensitivityOptions" />
        </UFormField>
        <UFormField label="正文">
          <UTextarea v-model="form.content" :rows="8" autoresize class="w-full font-mono" />
        </UFormField>
        <NoteLine v-if="looksPlaintext" tone="error">
          正文疑似包含明文凭据
          <template #detail>
            建议转存为凭据（「凭据」页），正文改用占位符；创建后可在编辑器中插入引用。
          </template>
        </NoteLine>
        <UFormField label="触发场景" help="什么场景下应该想起这条记忆">
          <UInput v-model="form.disclosure" class="w-full" />
        </UFormField>
        <UFormField label="有效期">
          <template #help>
            仅对阶段性内容设置；到期后不再召回。<Hint>
              到期后也不进启动加载。留空表示长期有效。
            </Hint>
          </template>
          <UInput
            v-model="form.validTo"
            type="datetime-local"
            :min="minValidTo"
            aria-label="有效期"
            class="w-full sm:w-64"
            @focus="minValidTo = earliestValidTo()"
          />
        </UFormField>
        <NoteLine v-if="error" tone="error">{{ error }}</NoteLine>
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
