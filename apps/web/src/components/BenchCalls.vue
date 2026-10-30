<script setup lang="ts">
import type { BenchRunResult } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, shallowRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  buildStep,
  callTargets,
  formFromJson,
  jsonFromForm,
  newDraft,
  targetGroups,
  type Draft,
} from '../benchForm'
import { useBench } from '../composables/useBench'
import { icons } from '../icons'
import { scopesSummary } from '../labels'
import BenchContextForm from './BenchContextForm.vue'
import BenchField from './BenchField.vue'
import BenchStepView from './BenchStepView.vue'

// 调用台：调一个工具或发一个生命周期事件，看宿主收到什么。工具目录来自真实的 tools/list
const { spaceId, appId, keyId, real, mode, running, generation, sessionContext, execute } =
  useBench()

const tools = useQuery({
  queryKey: computed(() => ['bench-tools', spaceId.value, appId.value, keyId.value]),
  queryFn: () => api.benchTools(spaceId.value, appId.value!, keyId.value!),
  enabled: computed(() => Boolean(appId.value && keyId.value)),
})
const targets = computed(() => callTargets(tools.data.value?.tools ?? []))
const groups = computed(() =>
  targetGroups.map((group) => ({
    ...group,
    targets: targets.value.filter((t) => t.group === group.value),
  })),
)
const targetId = ref(targets.value[0]!.id)
const target = computed(
  () => targets.value.find((t) => t.id === targetId.value) ?? targets.value[0]!,
)

// 每个调用一份草稿：切到别的调用再切回来时还在。只在内存里，可能有明文，不进浏览器存储
const drafts = new Map<string, Draft>()
const draft = computed(() => {
  const found = drafts.get(target.value.id)
  if (found) return found
  const created = reactive(newDraft(target.value))
  drafts.set(target.value.id, created)
  return created
})
function resetDraft() {
  Object.assign(draft.value, newDraft(target.value))
  formError.value = null
}
watch(spaceId, () => drafts.clear())

// 表单写错了发不出去、JSON 放不回表单时的说明
const formError = ref<string | null>(null)
watch(targetId, () => (formError.value = null))
function showJson() {
  const made = jsonFromForm(target.value, draft.value, sessionContext.value)
  if (!made.ok) {
    formError.value = made.error
    return
  }
  draft.value.text = made.text
  draft.value.json = true
  formError.value = null
}
function showForm() {
  const made = formFromJson(target.value, draft.value, sessionContext.value)
  if (!made.ok) {
    formError.value = made.error
    return
  }
  draft.value.state = made.state
  draft.value.json = false
  formError.value = null
}

const failure = ref<string | null>(null)
const result = shallowRef<BenchRunResult | null>(null)
// 换了应用、Key 或模式时清掉结果：它们属于别的 Key 或别的模式
watch(generation, () => {
  result.value = null
  failure.value = null
})

async function run() {
  if (running.value) return
  failure.value = null
  const built = buildStep(target.value, draft.value, sessionContext.value)
  if (!built.ok) {
    formError.value = built.error
    return
  }
  formError.value = null
  const outcome = await execute([built.step])
  if (outcome.kind === 'done') result.value = outcome.result
  else if (outcome.kind === 'failed') failure.value = outcome.message
}

// 回车只在回滚模式下运行：真实模式下填到一半按回车不能真的写进去，只有点按钮才执行
function onSubmit() {
  if (!real.value) void run()
}
function onRunClick() {
  if (real.value) void run()
}
</script>

<template>
  <div class="space-y-4">
    <BenchContextForm />
    <UAlert
      v-if="tools.isError.value && !tools.data.value"
      color="error"
      variant="subtle"
      :title="tools.error.value instanceof ApiError ? tools.error.value.message : '读取工具失败'"
    />
    <div class="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav class="max-h-72 space-y-3 overflow-y-auto text-sm lg:max-h-none" aria-label="调用目录">
        <section v-for="group in groups" :key="group.value" class="space-y-1">
          <h3 class="text-xs font-medium text-muted">{{ group.label }}</h3>
          <USkeleton v-if="group.value === 'tool' && tools.isPending.value" class="h-24 w-full" />
          <ul v-else>
            <li v-for="t in group.targets" :key="t.id">
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-1 rounded px-2 py-1 text-left hover:bg-elevated"
                :class="{ 'bg-elevated font-medium': t.id === target.id }"
                :aria-current="t.id === target.id ? 'true' : undefined"
                @click="targetId = t.id"
              >
                <span class="font-mono text-xs break-all">{{ t.id }}</span>
                <UBadge v-if="t.readOnly" size="sm" color="neutral" variant="subtle">只读</UBadge>
                <UBadge v-if="t.destructive" size="sm" color="warning" variant="subtle">
                  破坏性
                </UBadge>
              </button>
            </li>
          </ul>
        </section>
      </nav>

      <div class="min-w-0 space-y-4">
        <form class="space-y-3" novalidate @submit.prevent="onSubmit">
          <div class="space-y-1">
            <h3 class="flex flex-wrap items-center gap-2 text-sm font-medium">
              <code>{{ target.id }}</code>
              <UBadge v-if="target.readOnly" size="sm" color="neutral" variant="subtle">
                只读
              </UBadge>
              <UBadge v-if="target.destructive" size="sm" color="warning" variant="subtle">
                破坏性
              </UBadge>
            </h3>
            <p v-if="target.description" class="text-xs text-muted">{{ target.description }}</p>
            <p v-if="target.group === 'tool'" class="text-xs text-muted">
              工具调用不带会话上下文，真实的 MCP 也不带：按这把 Key 的全部权限读写。
            </p>
            <p v-else-if="target.usesContext" class="text-xs text-muted">
              这个调用带上面的会话上下文。
            </p>
          </div>

          <template v-if="target.hasBody">
            <UTextarea
              v-if="draft.json"
              v-model="draft.text"
              :rows="8"
              autoresize
              aria-label="JSON"
              class="w-full font-mono"
            />
            <template v-else-if="target.fields?.length">
              <BenchField
                v-for="field in target.fields"
                :key="field.name"
                :field="field"
                :value="draft.state.values[field.name] ?? ''"
                :is-null="Boolean(draft.state.nulls[field.name])"
                @update:value="(v) => (draft.state.values[field.name] = v)"
                @update:is-null="(v) => (draft.state.nulls[field.name] = v)"
              />
            </template>
            <p v-else class="text-sm text-muted">这个工具没有参数。</p>
            <p class="text-xs text-muted">
              字符串里可以写 <code>${run}</code>（每次运行不同的标记）与 <code>${expires}</code>（6
              小时后，给 valid_to 用）。校验由服务端做，不合法的请求也会发出去。
            </p>
          </template>

          <UAlert v-if="formError" color="warning" variant="subtle" :title="formError" />
          <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              :type="real ? 'button' : 'submit'"
              :color="real ? 'error' : 'primary'"
              :icon="icons.preview"
              :loading="running"
              @click="onRunClick"
            >
              {{ real ? '真实执行' : '运行' }}
            </UButton>
            <template v-if="target.hasBody && target.fields">
              <UButton
                v-if="draft.json"
                :icon="icons.form"
                color="neutral"
                variant="subtle"
                @click="showForm"
              >
                用表单
              </UButton>
              <UButton v-else :icon="icons.json" color="neutral" variant="subtle" @click="showJson">
                写 JSON
              </UButton>
            </template>
            <UButton
              v-if="target.hasBody"
              :icon="icons.restore"
              color="neutral"
              variant="ghost"
              @click="resetDraft"
            >
              重置
            </UButton>
          </div>
        </form>

        <div v-if="result" class="space-y-2">
          <p class="text-xs text-muted">
            运行标记 <code>{{ result.run }}</code> · {{ result.whoami.app.name }} ·
            {{ scopesSummary(result.whoami.scopes) }}
          </p>
          <BenchStepView
            v-for="step in result.steps"
            :key="`${result.run}-${step.index}`"
            :step="step"
            :mode="mode"
            view="call"
          />
        </div>
      </div>
    </div>
  </div>
</template>
