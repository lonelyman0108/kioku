<script setup lang="ts">
import {
  DISCLOSURE_MAX,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_NEW_MAX,
  EntrySummary,
  NewEntryTitle,
  TOPICS_MAX,
  TopicTag,
  type EntryDetailResponse,
  type EntryFacetsSummary,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { detectSecretPrefixes } from '../secretHint'
import { earliestValidTo, fromLocalInput, validToTooSoon } from '../time'
import { analyzeTitleHint } from '../titleHint'
import SceneScopePicker, { type SceneScopeValue } from './SceneScopePicker.vue'
import NoteLine from './ui/NoteLine.vue'

withDefaults(
  defineProps<{
    facets?: EntryFacetsSummary | null
  }>(),
  { facets: null },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [detail: EntryDetailResponse] }>()

const form = reactive({
  title: '',
  summary: '',
  content: '',
  disclosure: '',
  isPinned: false,
  topics: [] as string[],
  validTo: '',
})
const scope = ref<SceneScopeValue>({ envs: [], realms: [], projects: [], runtimes: [] })
const minValidTo = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

watch(open, (visible) => {
  if (!visible) return
  form.title = ''
  form.summary = ''
  form.content = ''
  form.disclosure = ''
  form.isPinned = false
  form.topics = []
  form.validTo = ''
  scope.value = { envs: [], realms: [], projects: [], runtimes: [] }
  minValidTo.value = earliestValidTo()
  error.value = null
})

const secretWarnings = computed(() => detectSecretPrefixes(form.content))
const titleHint = computed(() => analyzeTitleHint(form.title, form.content, 'create'))

function applyCleanTitle() {
  const split = titleHint.value.splittable
  if (!split) return
  form.title = split.cleanTitle
}

const validationProblem = computed(() => {
  if (form.title.trim()) {
    const parsed = NewEntryTitle.safeParse(form.title)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '标题格式有误'
  }
  if (form.summary.trim()) {
    const parsed = EntrySummary.safeParse(form.summary)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '现行概要格式有误'
  }
  if (form.topics.length > TOPICS_MAX) return `主题标签最多 ${TOPICS_MAX} 个`
  for (const tag of form.topics) {
    const parsed = TopicTag.safeParse(tag)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '主题标签格式有误'
  }
  if (form.validTo && validToTooSoon(form.validTo)) return '有效期须晚于当前时间至少 1 分钟'
  return null
})

const canSubmit = computed(
  () => form.content.trim().length > 0 && !validationProblem.value && !saving.value,
)

async function submit() {
  if (!canSubmit.value) return
  saving.value = true
  error.value = null
  try {
    const validTo = form.validTo ? fromLocalInput(form.validTo) : null
    const detail = await api.createEntry({
      ...(form.title.trim() ? { title: form.title.trim() } : {}),
      summary: form.summary.trim() || null,
      content: form.content,
      disclosure: form.disclosure.trim() || null,
      isPinned: form.isPinned,
      topics: form.topics,
      envs: scope.value.envs,
      realms: scope.value.realms,
      projects: scope.value.projects,
      runtimes: scope.value.runtimes,
      validTo,
    })
    open.value = false
    emit('created', detail)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '新建失败，请重试'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="新建记忆"
    :dismissible="!saving"
    :ui="{ content: 'max-w-2xl sm:max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标题">
            <UInput v-model="form.title" :maxlength="ENTRY_TITLE_NEW_MAX" class="w-full" />
            <template #help>
              <div v-if="titleHint.message" class="title-hint-row">
                <span class="title-hint-text">{{ titleHint.message }}</span>
                <UButton
                  v-if="titleHint.splittable"
                  type="button"
                  size="xs"
                  color="warning"
                  variant="outline"
                  :icon="icons.split"
                  @click="applyCleanTitle"
                >
                  精简为短标题
                </UButton>
              </div>
              <span v-else>留空时自动提取正文首个标题或短 ID</span>
            </template>
          </UFormField>
          <UFormField label="主题">
            <UInputTags v-model="form.topics" add-on-blur placeholder="输入后回车" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="现行概要（可选）" help="1–2 句概括当前结论，用于启动加载与列表预览">
          <UTextarea
            v-model="form.summary"
            :rows="2"
            autoresize
            :maxrows="4"
            :maxlength="ENTRY_SUMMARY_MAX"
            placeholder="例如：生产环境统一使用 Docker Compose 部署，反向代理监听本机回环端口。"
            class="w-full"
          />
        </UFormField>

        <NoteLine v-if="secretWarnings.length" tone="warning">
          正文疑似包含{{
            secretWarnings.map((w) => w.label).join('、')
          }}，建议改存凭据并用占位符引用。
          <template #actions>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :to="{ name: 'credentials' }"
              @click="open = false"
            >
              前往凭据
            </UButton>
          </template>
        </NoteLine>

        <UFormField label="正文（Markdown）">
          <UTextarea
            v-model="form.content"
            :rows="10"
            autoresize
            :maxrows="20"
            placeholder="支持 Markdown、[[m-xxxxxx]] 双链与 {{cred:slug}} 凭据占位符"
            class="w-full font-mono"
          />
        </UFormField>

        <div class="flex flex-wrap items-center gap-6">
          <USwitch v-model="form.isPinned" label="启动加载（会话开始时自动注入）" />
        </div>

        <UFormField label="适用场景">
          <SceneScopePicker v-model="scope" :facets="facets" />
        </UFormField>

        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="触发场景（可选）" help="简述何时需要召回此记忆">
            <UInput v-model="form.disclosure" :maxlength="DISCLOSURE_MAX" class="w-full" />
          </UFormField>
          <UFormField label="有效期（可选）" help="留空表示长期有效">
            <UInput
              v-model="form.validTo"
              type="datetime-local"
              :min="minValidTo"
              class="w-full"
              @focus="minValidTo = earliestValidTo()"
            />
          </UFormField>
        </div>

        <p v-if="error || validationProblem" class="text-sm text-error" role="alert">
          {{ error ?? validationProblem }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
          取消
        </UButton>
        <UButton :loading="saving" :disabled="!canSubmit" @click="submit">创建</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.title-hint-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.title-hint-text {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-warning);
}
</style>
