<script setup lang="ts">
import {
  CONVERT_VALUE_MIN_LENGTH,
  type ConsoleMemoryView,
  type ConvertedToCredential,
} from '@kioku/contracts'
import { toRef, useId, watch } from 'vue'

import { useConvertCredential } from '../composables/useConvertCredential'
import { CONVERT_SCOPE_TEXT, convertSummary } from '../plaintext'
import { memoryRoute } from '../routes'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import UriPath from './strata/UriPath.vue'

// 转存为凭据的对话框，状态和规则在 useConvertCredential。没有表单：回车的隐式提交会跳过核对
const props = defineProps<{ spaceId: string; uri: string | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  converted: [memory: ConsoleMemoryView, result: ConvertedToCredential]
}>()

const {
  memory,
  loading,
  loadFailure,
  form,
  candidates,
  shown,
  failure,
  canReload,
  submitting,
  result,
  blocked,
  replaced,
  context,
  placeholder,
  problem,
  canSubmit,
  leftovers,
  pick,
  load,
  reset,
  submit,
} = useConvertCredential(toRef(props, 'spaceId'), toRef(props, 'uri'), (changed, done) =>
  emit('converted', changed, done),
)

watch(open, (isOpen) => {
  reset()
  if (isOpen) void load()
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
      <NoteLine v-else-if="loadFailure" tone="error">
        {{ loadFailure }}
        <template #actions>
          <UButton size="sm" color="primary" variant="outline" @click="load">重新读取</UButton>
        </template>
      </NoteLine>
      <NoteLine v-else-if="memory && memory.content === null">
        机密记忆的正文已加密，无需转存为凭据
      </NoteLine>
      <!-- 占位符放不进这条记忆：提交一定失败，值不显示，先去调整 -->
      <div v-else-if="memory && blocked" class="convert-form">
        <p class="convert-target">
          <StrataSwatch :layer="memory.layer" :sensitivity="memory.sensitivity" />
          <UriPath :uri="memory.uri" />
        </p>
        <NoteLine tone="warning">
          这条记忆暂不能转存为凭据
          <template #detail>{{ CONVERT_SCOPE_TEXT }}</template>
          <template #actions>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              :to="memoryRoute(spaceId, memory.uri)"
              @click="close"
            >
              查看记忆
            </UButton>
          </template>
        </NoteLine>
      </div>
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
            <UButton size="sm" color="primary" variant="outline" @click="load">重新读取</UButton>
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
        <UButton v-if="!blocked" :loading="submitting" :disabled="!canSubmit" @click="submit">
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
