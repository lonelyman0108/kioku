<script setup lang="ts">
import {
  CONVERT_VALUE_MIN_LENGTH,
  ConvertToCredentialRequest,
  type ConsoleMemoryView,
  type ConvertedToCredential,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, useId, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { refreshAfterPlaintext } from '../composables/usePlaintextActions'
import {
  convertLeftovers,
  convertSummary,
  occurrences,
  plaintextCandidates,
  suggestIdentifier,
  suggestName,
  valueContext,
  type PlaintextCandidate,
} from '../plaintext'
import { placeholderOf } from '../placeholders'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 转存为凭据。规则只认得出值从哪里开始，结尾是猜的，所以值默认遮盖，但要显示过、核对过当前的值才能提交；
// 显示之后还能改。没有表单：回车的隐式提交会跳过核对。
// 打开时重新读这条记忆，提交带上这时的版本：值是这时看到的，期间被改过就由服务端拒绝。
// 值只留在这个组件里，提交成功或者关上就清掉
const props = defineProps<{ spaceId: string; uri: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  converted: [memory: ConsoleMemoryView, result: ConvertedToCredential]
}>()
const queryClient = useQueryClient()

const memory = ref<ConsoleMemoryView | null>(null)
const loading = ref(false)
const loadFailure = ref<string | null>(null)
const form = reactive({ value: '', field: 'password', identifier: '', name: '' })
const candidates = ref<PlaintextCandidate[]>([])
// 当前显示着值吗。核对过的那个值记在 checkedValue：隐藏之后改过，要再显示一次才算核对过
const shown = ref(false)
const checkedValue = ref<string | null>(null)
const failure = ref<string | null>(null)
// 失败多半是看到的那一版已经旧了：可以重新读取
const canReload = ref(false)
const submitting = ref(false)
const result = ref<ConvertedToCredential | null>(null)

function pick(candidate: PlaintextCandidate | undefined) {
  form.value = candidate?.value ?? ''
  form.field = candidate?.field ?? 'password'
  shown.value = false
  checkedValue.value = null
}

// 每次读取一个序号：关掉或者换了一条之后，晚到的结果不算。
// again 是失败之后重新读取：填好的留着，值在新的正文里还有就不换，但要再核对一次
let loadId = 0
async function load(again: boolean) {
  const uri = props.uri
  if (!uri) return
  const id = ++loadId
  const sid = props.spaceId
  loading.value = true
  loadFailure.value = null
  failure.value = null
  canReload.value = false
  try {
    const [view, existing] = await Promise.all([
      queryClient.fetchQuery({
        queryKey: ['memory', sid, uri],
        queryFn: () => api.memory(sid, uri),
        staleTime: 0,
      }),
      // 建议的标识避开已有的。只是建议，读不到也不影响转存，冲突以服务端为准
      queryClient
        .fetchQuery({
          queryKey: ['credentials', sid],
          queryFn: () => api.credentials(sid),
          staleTime: 60_000,
        })
        .catch(() => null),
    ])
    if (id !== loadId) return
    memory.value = view
    candidates.value = plaintextCandidates(view.content ?? '')
    const field = form.field
    const value = form.value
    pick(candidates.value[0])
    if (again) {
      form.field = field
      if (occurrences(view.content ?? '', value)) form.value = value
      return
    }
    form.identifier = suggestIdentifier(
      view.uri,
      form.field,
      (existing?.items ?? []).map((c) => c.identifier),
    )
    form.name = suggestName(view.uri)
  } catch (err) {
    if (id === loadId) loadFailure.value = err instanceof ApiError ? err.message : '读取失败'
  } finally {
    if (id === loadId) loading.value = false
  }
}

function reset() {
  loadId++
  memory.value = null
  candidates.value = []
  result.value = null
  failure.value = null
  canReload.value = false
  loadFailure.value = null
  Object.assign(form, { value: '', field: 'password', identifier: '', name: '' })
  shown.value = false
  checkedValue.value = null
}

watch(open, (isOpen) => {
  reset()
  if (isOpen) void load(false)
})
// 换了空间：对话框里的内容属于上一个
watch(
  () => props.spaceId,
  () => {
    open.value = false
  },
)

function close() {
  if (!submitting.value) open.value = false
}

// 显示着的值才算核对过
watch([shown, () => form.value], () => {
  if (shown.value) checkedValue.value = form.value
})

const content = computed(() => memory.value?.content ?? '')
const replaced = computed(() => occurrences(content.value, form.value))
const context = computed(() => (shown.value ? valueContext(content.value, form.value) : null))
const placeholder = computed(() =>
  form.identifier && form.field ? placeholderOf(form.identifier, form.field) : '',
)

const body = computed(() => ({
  memoryId: memory.value?.id ?? '',
  expectedVersion: memory.value?.version ?? 0,
  value: form.value,
  identifier: form.identifier,
  name: form.name.trim(),
  field: form.field,
}))
// 提交前在界面上能看出来的问题，服务端照样会检查。规则直接用接口的定义，提示与服务端一致
const problem = computed<string | null>(() => {
  if (!memory.value) return null
  const parsed = ConvertToCredentialRequest.safeParse(body.value)
  if (!parsed.success) return parsed.error.issues[0]?.message ?? '填写内容有误'
  if (!replaced.value) return '正文中没有这段值'
  if (checkedValue.value !== form.value) return '请先显示并核对值'
  return null
})

async function submit() {
  if (submitting.value || problem.value || !memory.value) return
  const sid = props.spaceId
  submitting.value = true
  failure.value = null
  canReload.value = false
  try {
    const done = await api.convertToCredential(sid, body.value)
    form.value = ''
    shown.value = false
    checkedValue.value = null
    result.value = done
    refreshAfterPlaintext(queryClient, sid, done.memory)
    // 版本变了，涉及这条记忆的整理建议随之作废
    for (const key of ['credentials', 'dream-suggestions']) {
      void queryClient.invalidateQueries({ queryKey: [key, sid] })
    }
    emit('converted', done.memory, done)
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : '转存失败'
    canReload.value = err instanceof ApiError && (err.status === 400 || err.status === 409)
    if (err instanceof ApiError && (err.status === 404 || err.status === 409)) {
      refreshAfterPlaintext(queryClient, sid)
    }
  } finally {
    submitting.value = false
  }
}

const leftovers = computed(() => (result.value ? convertLeftovers(result.value) : []))
const valueInput = useId()
const candidateGroup = useId()
</script>

<template>
  <UModal
    :open="open"
    :title="result ? '已转存为凭据' : '转存为凭据'"
    :dismissible="!submitting"
    :close="!submitting"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(v) => !v && close()"
  >
    <template #body>
      <!-- 结果：只换了选定的这一个值，还留在别处的要说清 -->
      <div v-if="result" class="convert-result">
        <p>{{ convertSummary(result) }}</p>
        <NoteLine v-for="item in leftovers" :key="item.title" tone="warning">
          {{ item.title }}
          <template #detail>{{ item.detail }}</template>
        </NoteLine>
      </div>
      <USkeleton v-else-if="loading" class="h-40 w-full" />
      <NoteLine v-else-if="loadFailure" tone="error">{{ loadFailure }}</NoteLine>
      <NoteLine v-else-if="memory && memory.content === null">
        机密记忆的正文已加密，无需转存为凭据
      </NoteLine>
      <div v-else-if="memory" class="convert-form">
        <p class="convert-target">
          <StrataSwatch :layer="memory.layer" :sensitivity="memory.sensitivity" />
          <UriPath :uri="memory.uri" />
        </p>

        <div
          v-if="candidates.length > 1"
          class="candidates"
          role="radiogroup"
          aria-label="要转存的值"
        >
          <label v-for="(candidate, i) in candidates" :key="i" class="candidate">
            <input
              type="radio"
              :name="candidateGroup"
              :checked="form.value === candidate.value"
              @change="pick(candidate)"
            />
            <span class="font-mono">{{ candidate.field }}</span>
            <span class="candidate-length">{{ [...candidate.value].length }} 个字符</span>
          </label>
        </div>

        <div>
          <label class="convert-label" :for="valueInput">值</label>
          <div class="value-row">
            <UInput
              :id="valueInput"
              v-model="form.value"
              :type="shown ? 'text' : 'password'"
              autocomplete="new-password"
              class="w-full font-mono"
            />
            <UButton
              color="primary"
              variant="outline"
              :aria-pressed="shown"
              @click="shown = !shown"
            >
              {{ shown ? '隐藏' : '显示' }}
            </UButton>
          </div>
          <p class="value-note">
            值的结尾是推测的，请显示并核对，可直接修改。
            <Hint>
              至少
              {{ CONVERT_VALUE_MIN_LENGTH }}
              个字符。正文中这个值出现几处换几处，历史版本中的也一并替换。
            </Hint>
          </p>
          <p v-if="context" class="value-context">
            <span v-if="context.clippedBefore">…</span>{{ context.before
            }}<mark>{{ form.value }}</mark
            >{{ context.after }}<span v-if="context.clippedAfter">…</span>
          </p>
        </div>

        <div class="convert-fields">
          <UFormField label="凭据标识">
            <UInput v-model="form.identifier" class="w-full font-mono" autocomplete="off" />
          </UFormField>
          <UFormField label="名称">
            <UInput v-model="form.name" class="w-full" autocomplete="off" />
          </UFormField>
          <UFormField label="字段名">
            <UInput v-model="form.field" class="w-full font-mono" autocomplete="off" />
          </UFormField>
        </div>

        <p v-if="placeholder && replaced" class="convert-effect">
          正文中 {{ replaced }} 处将换成 <code>{{ placeholder }}</code>
        </p>

        <NoteLine v-if="failure" tone="error">
          {{ failure }}
          <template v-if="canReload" #actions>
            <UButton size="sm" color="primary" variant="outline" @click="load(true)">
              重新读取
            </UButton>
          </template>
        </NoteLine>
      </div>
    </template>
    <template #footer>
      <div v-if="result" class="flex w-full justify-end gap-2">
        <UButton
          color="primary"
          variant="outline"
          :to="{
            name: 'credentials',
            params: { spaceId },
            query: { id: result.credential.id },
          }"
          @click="close"
        >
          查看凭据
        </UButton>
        <UButton @click="close">完成</UButton>
      </div>
      <div v-else class="convert-footer">
        <span class="convert-problem">{{ problem }}</span>
        <UButton color="neutral" variant="ghost" :disabled="submitting" @click="close"
          >取消</UButton
        >
        <UButton :loading="submitting" :disabled="!memory || Boolean(problem)" @click="submit">
          转存为凭据
        </UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.convert-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 14px;
}
.convert-target {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.candidate input {
  accent-color: var(--ui-text-highlighted);
}
.candidate-length {
  color: var(--ui-text-muted);
}
.convert-label {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25rem;
}
.value-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.value-row > :last-child {
  flex: none;
  white-space: nowrap;
}
.value-note {
  margin-top: 4px;
  color: var(--ui-text-muted);
}
.value-context {
  margin-top: 6px;
  padding: 7px 10px;
  border: 1px solid var(--ui-border-accented);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.value-context mark {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.convert-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.convert-effect {
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.convert-effect code {
  color: var(--ui-text);
}
.convert-result {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;
}
.convert-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
.convert-problem {
  flex: 1 1 12em;
  font-size: 14px;
  color: var(--ui-text-muted);
}
@media (max-width: 640px) {
  .convert-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
