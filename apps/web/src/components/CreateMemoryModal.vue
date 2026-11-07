<script setup lang="ts">
import {
  DEFAULT_SENSITIVITY,
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
  draftFromKey,
  draftProblem,
  draftUri,
  identifierFromTitle,
  type CoordinateDraft,
} from '../coordinates'
import { sensitivityLabels } from '../labels'
import { canManageCredentials } from '../vault'
import {
  addedSpots,
  afterGate,
  plaintextRejection,
  spotsAfterRejection,
  type PlaintextSpot,
  type SaveFlags,
} from '../plaintextSave'
import type { PlaintextSaveRequest, PlaintextSaveResult } from '../composables/usePlaintextSave'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import CoordinateFields from './CoordinateFields.vue'
import Hint from './Hint.vue'
import PlaintextSaveModal from './PlaintextSaveModal.vue'
import NoteLine from './strata/NoteLine.vue'
import SwatchOptions from './strata/SwatchOptions.vue'

// 新建记忆：选归属（人格、应用还要选是哪个）、位置、标题与标识，坐标随之拼出来。
// from 是目录里选中的那一行（根、人格或应用、位置、记忆），带出归属与位置
const props = defineProps<{ spaceId: string; from: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [uri: string] }>()

const { apps, role, canWrite, sensitivities, canWriteUri } = useMemoryPermissions(
  computed(() => props.spaceId),
)
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
  if (!value) {
    plaintextGate.value = null
    return
  }
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
// 正文疑似有明文密码或令牌时先提醒；创建时逐处选转存为凭据或不是凭据（PlaintextSaveModal）
const looksPlaintext = computed(() => PLAINTEXT_CREDENTIAL.test(form.content))
const plaintextGate = ref<PlaintextSaveRequest | null>(null)
const gateFor = (target: string, content: string, spots: PlaintextSpot[], rejected: boolean) => ({
  content,
  uri: target,
  title: form.title,
  layer: draft.value.layer,
  sensitivity: form.sensitivity,
  spots,
  rejected,
})
// 逐处处理完：换过的正文放回表单再创建。这期间正文变了就按现在的重算（afterGate）
function onGateProceed(result: PlaintextSaveResult) {
  const target = uri.value
  const next = afterGate(null, form.content, result)
  if (next.kind === 'reopen') {
    // 转存了的值已经换进现在的正文：放回表单，只把新出现的几处再给人看
    form.content = next.content
    if (target) {
      plaintextGate.value = {
        ...gateFor(target, next.content, next.spots, false),
        ignored: next.ignored,
      }
    }
    return
  }
  form.content = next.content
  void submit(next.flags)
}
// 转存为凭据只看 canManageCredentials；照样保存给能写记忆的成员
const canConvert = computed(() => canManageCredentials(role.value))

// 不带标记时先查这次新增的疑似明文（新建时全算），和服务端拒绝写入是同一个判断；机密的正文加密，不用处理
async function submit(flags?: SaveFlags) {
  const target = uri.value
  if (!ready.value || !target || !title.value.success || saving.value) return
  // 本地就能判断的先查：免得转存建了凭据、改了正文才因为有效期停下
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
  if (!flags && form.sensitivity !== 'secret') {
    const spots = addedSpots(null, form.content)
    if (spots.length) {
      plaintextGate.value = gateFor(target, form.content, spots, false)
      return
    }
  }
  const content = form.content
  saving.value = true
  error.value = null
  try {
    const created = await api.createMemory(props.spaceId, {
      uri: target,
      title: title.value.data,
      content,
      sensitivity: form.sensitivity,
      ...(form.disclosure.trim() ? { disclosure: form.disclosure.trim() } : {}),
      ...(validTo ? { validTo } : {}),
      ...flags,
    })
    open.value = false
    emit('created', created.uri)
  } catch (err) {
    // 服务端检出了新增的疑似明文（两边判断有出入时）：照样逐处处理
    // 请求期间又改过正文时按现在的正文重算，没有新增的就照常报错
    const findings = plaintextRejection(err)
    const gate = findings && spotsAfterRejection(null, content, form.content, findings)
    if (gate) {
      plaintextGate.value = gateFor(target, gate.content, gate.spots, true)
      return
    }
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
          正文疑似包含明文凭据<Hint>
            创建前逐处选择转存为凭据或不是凭据；转存后正文中的值换成占位符，历史中不留明文。
          </Hint>
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
        <UButton :loading="saving" :disabled="!ready" @click="submit()">创建</UButton>
      </div>
      <!-- 逐处处理疑似明文：叠在新建的对话框上面 -->
      <PlaintextSaveModal
        v-model:request="plaintextGate"
        :space-id="spaceId"
        :can-convert="canConvert"
        :can-save-anyway="canWrite"
        @proceed="onGateProceed"
      />
    </template>
  </UModal>
</template>
