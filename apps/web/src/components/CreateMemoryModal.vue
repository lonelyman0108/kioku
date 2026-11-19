<script setup lang="ts">
import {
  DEFAULT_SENSITIVITY,
  ENTRY_TITLE_MAX,
  EntryTitle,
  PLAINTEXT_CREDENTIAL,
  SENSITIVITIES,
  TOPICS_MAX,
  TopicTag,
  VARIANTS_MAX,
  hasHomogeneousRealms,
  normalizeWhen,
  sensitivityAllowed,
  whenSignature,
  type ConsoleEntryView,
  type Sensitivity,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import type { PlaintextSaveRequest, PlaintextSaveResult } from '../composables/usePlaintextSave'
import { icons } from '../icons'
import { sensitivityLabels } from '../labels'
import { whenLabel } from '../memoryDetail'
import {
  addedVariantSpots,
  afterGate,
  joinVariantContents,
  plaintextRejection,
  replaceVariantsValues,
  spotsAfterRejection,
  type PlaintextSpot,
  type SaveFlags,
} from '../plaintextSave'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import { canManageCredentials } from '../vault'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import PlaintextSaveModal from './PlaintextSaveModal.vue'
import NoteLine from './strata/NoteLine.vue'
import SwatchOptions from './strata/SwatchOptions.vue'

interface DraftVariant {
  key: number
  when: Record<string, string[]>
  content: string
}

const props = withDefaults(
  defineProps<{
    circleId: string
    initialTopic?: string | null
    initialWhen?: Record<string, string[]> | null
  }>(),
  { initialTopic: null, initialWhen: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [entry: ConsoleEntryView] }>()

const { circleKind, role, canWrite, sensitivities } = useMemoryPermissions(
  computed(() => props.circleId),
)
const facetsQuery = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: open,
})

let nextSliceKey = 0
const makeVariant = (when?: Record<string, string[]> | null): DraftVariant => ({
  key: nextSliceKey++,
  when: normalizeWhen(when),
  content: '',
})

const form = reactive({
  title: '',
  topics: [] as string[],
  sensitivity: DEFAULT_SENSITIVITY.shared as Sensitivity,
  disclosure: '',
  // 有效期，datetime-local 输入框的本地时间；空表示一直有效
  validTo: '',
})
const variants = ref<DraftVariant[]>([makeVariant()])
const activeIdx = ref(0)
const error = ref<string | null>(null)
const saving = ref(false)
// 有效期最早能选的时间（见 earliestValidTo）：打开、聚焦选择器与提交之前重新算
const minValidTo = ref('')

const activeSlice = computed(() => variants.value[activeIdx.value] ?? variants.value[0]!)
const primaryRealms = computed(() => normalizeWhen(variants.value[0]?.when).realm ?? [])

watch(open, (value) => {
  if (!value) {
    plaintextGate.value = null
    return
  }
  const initialTopics = props.initialTopic ? [props.initialTopic.trim().toLowerCase()] : []
  Object.assign(form, {
    title: '',
    topics: initialTopics.filter(Boolean),
    sensitivity: DEFAULT_SENSITIVITY[circleKind.value],
    disclosure: '',
    validTo: '',
  })
  variants.value = [makeVariant(props.initialWhen)]
  activeIdx.value = 0
  minValidTo.value = earliestValidTo()
  error.value = null
})

watch(
  circleKind,
  (kind) => {
    if (!sensitivityAllowed(kind, 'entry', form.sensitivity)) {
      form.sensitivity = DEFAULT_SENSITIVITY[kind]
    }
  },
  { immediate: true },
)

// 机密词条的所有切片须保持相同的场域
function syncSecretRealms() {
  if (form.sensitivity !== 'secret' || variants.value.length <= 1) return
  const baseRealms = primaryRealms.value
  for (let i = 1; i < variants.value.length; i++) {
    const slice = variants.value[i]!
    const nextWhen = { ...normalizeWhen(slice.when) }
    if (baseRealms.length) nextWhen.realm = [...baseRealms]
    else delete nextWhen.realm
    slice.when = normalizeWhen(nextWhen)
  }
}
watch(
  () => form.sensitivity,
  (s) => s === 'secret' && syncSecretRealms(),
)
watch(primaryRealms, () => syncSecretRealms())

// editor 签不了 secret，个人圈不设公开：选项里都不给
const sensitivityOptions = computed(() =>
  SENSITIVITIES.filter(
    (s) => sensitivities.value.includes(s) && sensitivityAllowed(circleKind.value, 'entry', s),
  ).map((value) => ({
    value,
    label: sensitivityLabels[value],
    band: circleKind.value === 'personal' ? ('personal' as const) : ('primary' as const),
    sensitivity: value,
  })),
)

function addVariant() {
  if (variants.value.length >= VARIANTS_MAX) return
  const when: Record<string, string[]> =
    form.sensitivity === 'secret' && primaryRealms.value.length
      ? { realm: primaryRealms.value }
      : {}
  variants.value.push(makeVariant(when))
  activeIdx.value = variants.value.length - 1
}

function removeVariant(idx: number) {
  if (variants.value.length <= 1) return
  variants.value.splice(idx, 1)
  if (activeIdx.value >= variants.value.length) activeIdx.value = variants.value.length - 1
}

function updateActiveWhen(next: Record<string, string[]>) {
  const slice = activeSlice.value
  if (!slice) return
  slice.when = normalizeWhen(next)
  if (variants.value[0]?.key === slice.key) syncSecretRealms()
}

const title = computed(() => EntryTitle.safeParse(form.title))
const parsedTopics = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const raw of form.topics) {
    const res = TopicTag.safeParse(raw)
    if (!res.success)
      return { ok: false as const, message: res.error.issues[0]?.message ?? '主题格式错误' }
    if (!seen.has(res.data)) {
      seen.add(res.data)
      list.push(res.data)
    }
  }
  if (list.length > TOPICS_MAX)
    return { ok: false as const, message: `主题标签最多 ${TOPICS_MAX} 个` }
  return { ok: true as const, list }
})

const hasDuplicateWhen = computed(() => {
  const seen = new Set<string>()
  for (const v of variants.value) {
    const sig = whenSignature(v.when)
    if (seen.has(sig)) return true
    seen.add(sig)
  }
  return false
})
const hasEmptySlice = computed(() => variants.value.some((v) => !v.content.trim()))

// 还差什么：没填的必填项只在按钮上禁用，不提前报错
const problem = computed(() => {
  if (form.title.trim() && !title.value.success) {
    return title.value.error.issues[0]?.message ?? '标题格式错误'
  }
  if (!parsedTopics.value.ok) return parsedTopics.value.message
  if (hasDuplicateWhen.value) return '同一条记忆下不能存在适用切面相同的变体切片'
  if (form.sensitivity === 'secret' && !hasHomogeneousRealms(variants.value)) {
    return '机密记忆的所有变体切片须保持相同的场域'
  }
  return null
})

const ready = computed(
  () =>
    title.value.success &&
    parsedTopics.value.ok &&
    !hasEmptySlice.value &&
    !hasDuplicateWhen.value &&
    (form.sensitivity !== 'secret' || hasHomogeneousRealms(variants.value)),
)

const combinedContent = computed(() => joinVariantContents(variants.value) ?? '')
const looksPlaintext = computed(
  () => form.sensitivity !== 'secret' && PLAINTEXT_CREDENTIAL.test(combinedContent.value),
)
const plaintextGate = ref<PlaintextSaveRequest | null>(null)
const gateFor = (
  content: string,
  spots: PlaintextSpot[],
  rejected: boolean,
): PlaintextSaveRequest => ({
  content,
  title: form.title,
  circleKind: circleKind.value,
  kind: 'entry',
  sensitivity: form.sensitivity,
  spots,
  rejected,
})

function onGateProceed(result: PlaintextSaveResult) {
  const next = afterGate(null, combinedContent.value, result)
  if (result.replacements.length) {
    variants.value = replaceVariantsValues(variants.value, result.replacements)
  }
  if (next.kind === 'reopen') {
    plaintextGate.value = {
      ...gateFor(next.content, next.spots, false),
      ignored: next.ignored,
    }
    return
  }
  void submit(next.flags)
}

// 转存为凭据只看 canManageCredentials；照样保存给能写记忆的成员
const canConvert = computed(() => canManageCredentials(role.value))

async function submit(flags?: SaveFlags) {
  if (!ready.value || !title.value.success || !parsedTopics.value.ok || saving.value) return
  const validTo = form.validTo ? fromLocalInput(form.validTo) : null
  if (form.validTo && !validTo) {
    error.value = '有效期的日期和时间不完整'
    return
  }
  if (validTo && validToTooSoon(form.validTo)) {
    minValidTo.value = earliestValidTo()
    error.value = '有效期须晚于当前时间至少一分钟'
    return
  }
  const sentVariants = variants.value.map((v, sortOrder) => ({
    when: normalizeWhen(v.when),
    content: v.content,
    sortOrder,
  }))
  if (!flags && form.sensitivity !== 'secret') {
    const { content, spots } = addedVariantSpots(null, sentVariants)
    if (spots.length) {
      plaintextGate.value = gateFor(content, spots, false)
      return
    }
  }
  const sentJoined = joinVariantContents(sentVariants) ?? ''
  saving.value = true
  error.value = null
  try {
    const created = await api.createEntry(props.circleId, {
      title: title.value.data,
      variants: sentVariants,
      topics: parsedTopics.value.list,
      sensitivity: form.sensitivity,
      ...(form.disclosure.trim() ? { disclosure: form.disclosure.trim() } : {}),
      ...(validTo ? { validTo } : {}),
      ...flags,
    })
    open.value = false
    emit('created', created)
  } catch (err) {
    const findings = plaintextRejection(err)
    const gate = findings && spotsAfterRejection(null, sentJoined, combinedContent.value, findings)
    if (gate) {
      plaintextGate.value = gateFor(gate.content, gate.spots, true)
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
      <!-- 不用 form：单选在表单里时回车会隐式提交，敏感级还没看完就建好了。只有点创建才提交 -->
      <div class="space-y-4">
        <UFormField label="标题">
          <template #hint><Hint>目录、列表与搜索显示标题，之后可以改</Hint></template>
          <UInput
            v-model="form.title"
            :maxlength="ENTRY_TITLE_MAX"
            class="w-full"
            placeholder="例如：常用的部署步骤"
            autofocus
          />
        </UFormField>

        <UFormField label="主题">
          <template #hint><Hint>用于分组归类与筛选，按回车添加标签</Hint></template>
          <UInputTags v-model="form.topics" class="w-full" placeholder="例如：部署、后端" />
        </UFormField>

        <UFormField label="敏感级">
          <SwatchOptions v-model="form.sensitivity" label="敏感级" :options="sensitivityOptions" />
        </UFormField>

        <div class="slices-box">
          <div class="slices-head">
            <span class="slices-label">
              <UIcon :name="icons.variants" class="slices-icon" />
              <span>内容切片</span>
              <Hint>一条记忆可按场域、环境或项目维护多个变体切片，无条件切片作为默认值。</Hint>
            </span>
            <UButton
              v-if="variants.length < VARIANTS_MAX"
              type="button"
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.add"
              @click="addVariant"
            >
              添加切片
            </UButton>
          </div>

          <div class="slice-tabs" role="tablist" aria-label="变体切片">
            <button
              v-for="(v, idx) in variants"
              :key="v.key"
              type="button"
              role="tab"
              :aria-selected="idx === activeIdx"
              class="slice-tab"
              :class="{ active: idx === activeIdx }"
              @click="activeIdx = idx"
            >
              <span>{{ whenLabel(v.when, facetsQuery.data.value) }}</span>
              <UButton
                v-if="variants.length > 1"
                type="button"
                size="xs"
                color="neutral"
                variant="ghost"
                :icon="icons.cancel"
                aria-label="删除此切片"
                @click.stop="removeVariant(idx)"
              />
            </button>
          </div>

          <div v-if="activeSlice" class="slice-editor">
            <FacetWhenPicker
              :model-value="activeSlice.when"
              :circle-id="circleId"
              :vocabulary="facetsQuery.data.value"
              :locked-realms="
                form.sensitivity === 'secret' && activeIdx > 0 ? primaryRealms : undefined
              "
              @update:model-value="updateActiveWhen"
            />
            <UFormField label="正文">
              <UTextarea
                v-model="activeSlice.content"
                :rows="8"
                autoresize
                class="w-full font-mono"
              />
            </UFormField>
          </div>
        </div>

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
        :circle-id="circleId"
        :can-convert="canConvert"
        :can-save-anyway="canWrite"
        @proceed="onGateProceed"
      />
    </template>
  </UModal>
</template>

<style scoped>
.slices-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.slices-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.slices-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
}
.slices-icon {
  display: inline-block;
  width: 14px;
  height: 14px;
}
.slice-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.slice-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  background: var(--ui-bg);
  color: var(--ui-text-muted);
  cursor: pointer;
}
.slice-tab:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text);
}
.slice-tab.active {
  background: var(--strata-selected);
  border-color: var(--strata-selected-frame);
  color: var(--strata-on-selected);
}
.slice-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
