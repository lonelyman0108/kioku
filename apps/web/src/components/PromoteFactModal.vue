<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  DEFAULT_SENSITIVITY,
  DISCLOSURE_MAX,
  ENTRY_TITLE_MAX,
  EntryTitle,
  SENSITIVITIES,
  TOPICS_MAX,
  TopicTag,
  normalizeWhen,
  sensitivityAllowed,
  type CircleSummary,
  type ConsoleEntryView,
  type Sensitivity,
  type SubjectFact,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { sensitivityLabels } from '../labels'
import { refreshSubjectCaches } from '../subjectQueries'
import FacetWhenPicker from './FacetWhenPicker.vue'
import NoteLine from './strata/NoteLine.vue'
import SwatchOptions from './strata/SwatchOptions.vue'

// 将联系人的事实提炼为正式词条：选目标记忆圈、敏感级、标题、切面与双链标签；保留原事实记录不删除
const props = defineProps<{
  circleId: string
  subjectId: string
  subjectName: string
  fact: SubjectFact | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ promoted: [entry: ConsoleEntryView] }>()

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()

const writableCircles = computed<CircleSummary[]>(() =>
  (me.data.value?.circles ?? []).filter((c) => c.role === 'owner' || c.role === 'editor'),
)

const targetCircleId = ref('')
const targetCircle = computed<CircleSummary | null>(
  () => writableCircles.value.find((c) => c.id === targetCircleId.value) ?? null,
)
const targetKind = computed(() => targetCircle.value?.kind ?? 'shared')
const targetRole = computed(() => targetCircle.value?.role ?? 'viewer')

const facets = useQuery({
  queryKey: computed(() => ['facets', targetCircleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: computed(() => open.value && Boolean(targetCircleId.value)),
})

const form = reactive({
  title: '',
  content: '',
  sensitivity: DEFAULT_SENSITIVITY.shared as Sensitivity,
  topicsText: '',
  priority: 2,
  disclosure: '',
})
const when = ref<Record<string, string[]>>({})
const saving = ref(false)
const error = ref<string | null>(null)

function defaultTitle(content: string): string {
  const first = content.trim().split(/\r?\n/)[0] ?? ''
  return Array.from(first).slice(0, Math.min(40, ENTRY_TITLE_MAX)).join('')
}

function defaultSensitivityFor(circle: CircleSummary | null): Sensitivity {
  const base = circle ? DEFAULT_SENSITIVITY[circle.kind] : 'internal'
  if (circle?.role !== 'owner' && base === 'secret') return 'private'
  return base
}

watch(open, (value) => {
  if (!value) return
  const preferred =
    writableCircles.value.find((c) => c.id === props.circleId) ?? writableCircles.value[0] ?? null
  targetCircleId.value = preferred?.id ?? ''
  const raw = props.fact?.content ?? ''
  form.title = defaultTitle(raw)
  form.content = raw
  form.sensitivity = defaultSensitivityFor(preferred)
  form.topicsText = ''
  form.priority = 2
  form.disclosure = ''
  when.value = {}
  error.value = null
})

watch(targetCircle, (circle) => {
  if (!circle) return
  if (
    !sensitivityAllowed(circle.kind, 'entry', form.sensitivity) ||
    (form.sensitivity === 'secret' && circle.role !== 'owner')
  ) {
    form.sensitivity = defaultSensitivityFor(circle)
  }
})

const sensitivityOptions = computed(() =>
  SENSITIVITIES.filter(
    (s) =>
      sensitivityAllowed(targetKind.value, 'entry', s) &&
      (targetRole.value === 'owner' || s !== 'secret'),
  ).map((value) => ({
    value,
    label: sensitivityLabels[value],
    band: targetKind.value === 'personal' ? ('personal' as const) : ('primary' as const),
    sensitivity: value,
  })),
)

const circleItems = computed(() =>
  writableCircles.value.map((c) => ({
    label: c.kind === 'personal' ? `${c.name}（个人圈）` : c.name,
    value: c.id,
  })),
)

const priorityItems = [
  { label: '0 · 最高（启动加载）', value: 0 },
  { label: '1 · 高', value: 1 },
  { label: '2 · 普通', value: 2 },
  { label: '3 · 低', value: 3 },
]

const parsedTopics = computed(() => {
  const raw = form.topicsText
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const list: string[] = []
  for (const tag of raw) {
    const res = TopicTag.safeParse(tag)
    if (!res.success) {
      return { ok: false as const, message: res.error.issues[0]?.message ?? '主题标签格式错误' }
    }
    if (!seen.has(res.data)) {
      seen.add(res.data)
      list.push(res.data)
    }
  }
  if (list.length > TOPICS_MAX) {
    return { ok: false as const, message: `主题标签最多 ${TOPICS_MAX} 个` }
  }
  return { ok: true as const, list }
})

const problem = computed(() => {
  if (!writableCircles.value.length) return '没有可写入的目标记忆圈'
  if (!targetCircleId.value) return '请选择目标记忆圈'
  if (!form.content.trim()) return '正文不能为空'
  if (form.title.trim()) {
    const res = EntryTitle.safeParse(form.title.trim())
    if (!res.success) return res.error.issues[0]?.message ?? '标题格式错误'
  }
  if (!parsedTopics.value.ok) return parsedTopics.value.message
  if (form.disclosure.trim().length > DISCLOSURE_MAX) {
    return `触发场景最多 ${DISCLOSURE_MAX} 字`
  }
  return null
})

async function submit() {
  const fact = props.fact
  if (!fact || problem.value || saving.value) return
  saving.value = true
  error.value = null
  try {
    const entry = await api.promoteFact(props.circleId, props.subjectId, fact.id, {
      targetCircleId: targetCircleId.value,
      sensitivity: form.sensitivity,
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      content: form.content.trim(),
      when: normalizeWhen(when.value),
      topics: parsedTopics.value.ok ? parsedTopics.value.list : [],
      priority: form.priority,
      disclosure: form.disclosure.trim() ? form.disclosure.trim() : null,
    })
    await Promise.all([
      refreshSubjectCaches(queryClient, props.circleId, props.subjectId),
      queryClient.invalidateQueries({ queryKey: ['overview', targetCircleId.value] }),
      queryClient.invalidateQueries({ queryKey: ['entries', targetCircleId.value] }),
      queryClient.invalidateQueries({ queryKey: ['entry-list', targetCircleId.value] }),
      queryClient.invalidateQueries({ queryKey: ['browse-entries', targetCircleId.value] }),
    ])
    toast.add({ title: `已提炼为正式词条（${entry.shortId}）`, color: 'success' })
    open.value = false
    emit('promoted', entry)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '提炼失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="`提炼来自「${subjectName}」的事实`"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <!-- 不用 form：单选与切面按钮在表单里回车会隐式提交，确认后再创建 -->
      <div class="space-y-4">
        <NoteLine v-if="problem" tone="warning" flush>{{ problem }}</NoteLine>

        <UFormField v-if="writableCircles.length" label="目标记忆圈">
          <USelect
            v-model="targetCircleId"
            :items="circleItems"
            value-key="value"
            aria-label="目标记忆圈"
            class="w-full"
          />
        </UFormField>

        <UFormField label="敏感级">
          <SwatchOptions v-model="form.sensitivity" label="敏感级" :options="sensitivityOptions" />
        </UFormField>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <UInput
              v-model="form.title"
              :maxlength="ENTRY_TITLE_MAX"
              placeholder="词条标题，留空按正文开头生成"
              class="w-full"
            />
          </UFormField>
          <UFormField label="优先级">
            <USelect
              v-model="form.priority"
              :items="priorityItems"
              value-key="value"
              aria-label="优先级"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField label="正文">
          <UTextarea v-model="form.content" :rows="4" class="w-full" />
        </UFormField>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="主题标签" help="多个标签用逗号或空格分隔">
            <UInput
              v-model="form.topicsText"
              placeholder="例如 preferences, travel"
              class="w-full"
            />
          </UFormField>
          <UFormField label="触发场景" help="非启动加载词条建议写清">
            <UInput
              v-model="form.disclosure"
              :maxlength="DISCLOSURE_MAX"
              placeholder="何时参考此条"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField label="适用切面">
          <FacetWhenPicker
            v-model="when"
            :circle-id="targetCircleId || circleId"
            :vocabulary="facets.data.value ?? null"
          />
        </UFormField>

        <NoteLine v-if="error" tone="error" flush>{{ error }}</NoteLine>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :disabled="Boolean(problem)" :loading="saving" @click="submit">
          提炼为正式词条
        </UButton>
      </div>
    </template>
  </UModal>
</template>
