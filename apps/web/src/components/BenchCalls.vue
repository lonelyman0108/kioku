<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  buildStep,
  callTargets,
  formFromJson,
  jsonContextDiffers,
  jsonFromForm,
  newDraft,
  targetGroups,
  type Draft,
} from '../benchForm'
import { stepBadge } from '../benchResult'
import { divergenceNotice, runBlocker, sessionUsage } from '../benchSession'
import { useBench } from '../composables/useBench'
import { icons } from '../icons'
import { scopesSummary } from '../labels'
import BenchContextForm from './BenchContextForm.vue'
import BenchField from './BenchField.vue'
import BenchStepView from './BenchStepView.vue'

// 调用台：调一个工具或发一个生命周期事件，看宿主收到什么。工具目录来自真实的 tools/list。
// 连续调用：回滚模式下这次会话的写入靠重放带到后面的调用，时间线列出这次会话的调用
const {
  spaceId,
  appId,
  app,
  keyId,
  real,
  mode,
  running,
  generation,
  sessionContext,
  session,
  call,
  clearSession,
  acceptDiverged,
} = useBench()

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
const contextDiffers = computed(() =>
  jsonContextDiffers(target.value, draft.value, sessionContext.value),
)

const failure = ref<string | null>(null)
// 显示时间线上的哪一条；没选时显示最新的
const shownId = ref<number | null>(null)
const timeline = computed(() => [...session.value.timeline].reverse())
const shown = computed(
  () => timeline.value.find((entry) => entry.id === shownId.value) ?? timeline.value[0] ?? null,
)
// 换了应用、Key 或模式时会话已经换了一份新的，这里清掉报错：它们属于别的 Key 或别的模式
watch(generation, () => {
  failure.value = null
  shownId.value = null
})

const blocker = computed(() => runBlocker(session.value, mode.value))
const diverged = computed(() => divergenceNotice(session.value))
const usage = computed(() => sessionUsage(session.value, mode.value))
// 运行期间不能接受或清空：结果回来时，第几步与这次的写入都是按发出请求时的日志算的
const divergedActions = computed(() => [
  {
    label: '接受：去掉这一步',
    color: 'neutral' as const,
    variant: 'subtle' as const,
    disabled: running.value,
    onClick: acceptDiverged,
  },
  {
    label: '清空这次会话',
    color: 'error' as const,
    variant: 'subtle' as const,
    disabled: running.value,
    onClick: clear,
  },
])

function clear() {
  if (running.value) return
  clearSession()
  failure.value = null
  shownId.value = null
}

async function run() {
  if (running.value) return
  failure.value = null
  const built = buildStep(target.value, draft.value, sessionContext.value)
  if (!built.ok) {
    formError.value = built.error
    return
  }
  formError.value = null
  const outcome = await call([built.step])
  if (outcome.kind === 'done') shownId.value = null
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
      <nav class="space-y-3 text-sm" aria-label="调用目录">
        <section v-for="group in groups" :key="group.value" class="space-y-1">
          <h3 class="text-xs font-medium text-muted">{{ group.label }}</h3>
          <USkeleton v-if="group.value === 'tool' && tools.isPending.value" class="h-24 w-full" />
          <!-- 窄屏上一行放几个，不把表单挤到很下面 -->
          <ul v-else class="flex flex-wrap gap-x-1 lg:block">
            <li v-for="t in group.targets" :key="t.id">
              <button
                type="button"
                class="flex flex-wrap items-center gap-1 rounded px-2 py-1 text-left hover:bg-elevated lg:w-full"
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
            <template v-if="target.group === 'tool'">
              <p class="text-xs text-muted">
                工具调用不带会话上下文，真实的 MCP 也不带：按这把 Key 的全部权限读写。
              </p>
              <p v-if="app?.runtimeFamily === 'astrbot'" class="text-xs text-warning">
                不要给群聊 bot 接 MCP：群里的人能借工具读到这把 Key
                读得到的一切。这里只是测工具本身。
              </p>
            </template>
            <template v-else-if="target.usesContext">
              <p v-if="draft.json" class="text-xs text-muted">
                JSON 模式只发这段 JSON 里的 context，上面的会话上下文不起作用。
              </p>
              <p v-else class="text-xs text-muted">这个调用带上面的会话上下文。</p>
            </template>
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
            <p v-if="draft.json || target.fields?.length" class="text-xs text-muted">
              字符串里可以写 <code>${run}</code>（每次运行不同的标记）与 <code>${expires}</code>（6
              小时后，给 valid_to 用）。校验由服务端做，不合法的请求也会发出去。
            </p>
          </template>

          <UAlert
            v-if="contextDiffers"
            color="warning"
            variant="subtle"
            title="这段 JSON 里的 context 和上面的会话上下文不同：这次按 JSON 里的执行，没写就是不带。"
          />
          <UAlert v-if="formError" color="warning" variant="subtle" :title="formError" />
          <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              :type="real ? 'button' : 'submit'"
              :color="real ? 'error' : 'primary'"
              :icon="icons.preview"
              :loading="running"
              :disabled="Boolean(blocker)"
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

        <section class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium">这次会话</h3>
            <UButton
              class="ml-auto"
              size="xs"
              color="neutral"
              variant="subtle"
              :icon="icons.clear"
              :disabled="running || !timeline.length"
              @click="clear"
            >
              清空
            </UButton>
          </div>
          <p class="text-xs text-muted">{{ usage }}</p>
          <UAlert
            v-if="diverged"
            color="warning"
            variant="subtle"
            :title="diverged.title"
            :description="diverged.description"
            :actions="divergedActions"
          />
          <UAlert v-if="blocker" color="warning" variant="subtle" :title="blocker" />
          <ol v-if="timeline.length" class="max-h-64 divide-y divide-default overflow-y-auto">
            <li v-for="entry in timeline" :key="entry.id">
              <button
                type="button"
                class="flex w-full flex-wrap items-center gap-2 px-1 py-1.5 text-left text-xs hover:bg-elevated"
                :class="{ 'bg-elevated': entry.id === shown?.id }"
                :aria-current="entry.id === shown?.id ? 'true' : undefined"
                @click="shownId = entry.id"
              >
                <UBadge
                  size="sm"
                  variant="subtle"
                  :color="stepBadge(entry.step, 'call').color"
                  :icon="stepBadge(entry.step, 'call').icon"
                >
                  {{ stepBadge(entry.step, 'call').label }}
                </UBadge>
                <span class="min-w-0 flex-1 font-mono break-all">{{ entry.step.label }}</span>
                <UBadge v-if="entry.kept" size="sm" color="neutral" variant="subtle">
                  写入已保留
                </UBadge>
                <UBadge v-else-if="entry.removed" size="sm" color="warning" variant="subtle">
                  写入已去掉
                </UBadge>
                <span v-if="entry.step.raw !== null" class="text-muted">
                  {{ entry.step.ms }} ms
                </span>
              </button>
            </li>
          </ol>
          <p v-if="session.dropped" class="text-xs text-muted">
            更早的 {{ session.dropped }} 条不再显示，保留的写入不受影响。
          </p>
        </section>

        <div v-if="shown" class="space-y-2">
          <p class="text-xs text-muted">
            运行标记 <code>{{ shown.run }}</code> · {{ shown.whoami.app.name }} ·
            {{ scopesSummary(shown.whoami.scopes) }}
          </p>
          <BenchStepView :key="shown.id" :step="shown.step" :mode="mode" view="call" />
        </div>
      </div>
    </div>
  </div>
</template>
