<script setup lang="ts">
import {
  MemoryTitle,
  PLAINTEXT_CREDENTIAL,
  SENSITIVITIES,
  sensitivityAllowed,
  type Sensitivity,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import {
  DEFAULT_SENSITIVITY,
  draftFromKey,
  draftProblem,
  draftUri,
  identifierFromTitle,
  type CoordinateDraft,
} from '../coordinates'
import { sensitivityLabels } from '../labels'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import CoordinateFields from './CoordinateFields.vue'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SwatchOptions from './strata/SwatchOptions.vue'

// 新建记忆：选归属（人格、应用还要选是哪个）、位置、标题与标识，坐标随之拼出来。
// from 是目录里选中的那一行（根、人格或应用、位置、记忆），带出归属与位置
const props = defineProps<{ spaceId: string; from: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [uri: string] }>()

const { apps, sensitivities, canWriteUri } = useMemoryPermissions(computed(() => props.spaceId))
const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
  enabled: open,
})
// 编辑者只能写自己是所有者的应用
const writableApps = computed(() =>
  (apps.data.value ?? []).filter((a) => canWriteUri(`app://${a.slug}/x`)),
)

const emptyDraft = (): CoordinateDraft => ({
  layer: 'user',
  entity: null,
  position: '',
  identifier: '',
})
const draft = ref<CoordinateDraft>(emptyDraft())
const form = reactive({
  title: '',
  content: '',
  sensitivity: DEFAULT_SENSITIVITY.user as Sensitivity,
  disclosure: '',
  // 有效期，datetime-local 输入框的本地时间；空表示一直有效
  validTo: '',
})
const error = ref<string | null>(null)
const saving = ref(false)
// 有效期最早能选的时间（见 earliestValidTo）：打开、聚焦选择器与提交之前重新算
const minValidTo = ref('')

watch(open, (value) => {
  if (!value) return
  draft.value = { ...emptyDraft(), ...draftFromKey(props.from) }
  Object.assign(form, {
    title: '',
    content: '',
    sensitivity: DEFAULT_SENSITIVITY[draft.value.layer],
    disclosure: '',
    validTo: '',
  })
  minValidTo.value = earliestValidTo()
  error.value = null
})
// 换归属时敏感级换成那一类的默认值：本人没有公开
watch(
  () => draft.value.layer,
  (layer, previous) => {
    if (previous && layer !== previous) form.sensitivity = DEFAULT_SENSITIVITY[layer]
  },
)

// 标识可以不填：标题是英文时从标题猜一个
const suggestion = computed(() => identifierFromTitle(form.title))
const effective = computed(() => ({
  ...draft.value,
  identifier: draft.value.identifier.trim() || suggestion.value,
}))
const uri = computed(() => draftUri(effective.value))
const title = computed(() => MemoryTitle.safeParse(form.title))

// editor 签不了 secret，本人不设公开：选项里都不给
const sensitivityOptions = computed(() =>
  SENSITIVITIES.filter(
    (s) => sensitivities.value.includes(s) && sensitivityAllowed(draft.value.layer, s),
  ).map((value) => ({
    value,
    label: sensitivityLabels[value],
    layer: draft.value.layer,
    sensitivity: value,
  })),
)

// 还差什么：从上到下一次说一件；没填的必填项只在按钮上禁用，不提前报错
const problem = computed(() => {
  if (!form.title.trim()) return null
  if (!title.value.success) return title.value.error.issues[0]?.message ?? '标题格式错误'
  return draftProblem(effective.value)
})
const ready = computed(
  () => title.value.success && !draftProblem(effective.value) && !!form.content.trim(),
)
// 正文疑似有明文密码或令牌时提醒换成凭据占位符；只是提醒，照样能创建
const looksPlaintext = computed(() => PLAINTEXT_CREDENTIAL.test(form.content))

async function submit() {
  const target = uri.value
  if (!ready.value || !target || !title.value.success) return
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
      uri: target,
      title: title.value.data,
      content: form.content,
      sensitivity: form.sensitivity,
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
  <UModal v-model:open="open" title="新建记忆" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <!-- 不用 form：单选在表单里时回车会隐式提交，归属和敏感级还没看完就建好了。只有点创建才提交 -->
      <div class="space-y-4">
        <UFormField label="标题">
          <template #hint><Hint>目录、列表与搜索显示标题，之后可以改</Hint></template>
          <UInput
            v-model="form.title"
            class="w-full"
            placeholder="例如：常用的部署步骤"
            autofocus
          />
        </UFormField>
        <CoordinateFields
          v-model="draft"
          :personas="personas.data.value ?? []"
          :apps="writableApps"
          :sensitivity="form.sensitivity"
          :suggestion="suggestion"
        />
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
        <NoteLine v-else-if="problem" tone="warning">{{ problem }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton :loading="saving" :disabled="!ready" @click="submit">创建</UButton>
      </div>
    </template>
  </UModal>
</template>
