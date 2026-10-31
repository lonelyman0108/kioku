<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, shallowReactive, watch, watchEffect } from 'vue'

import { api } from '../api/endpoints'
import {
  buildStep,
  callTargets,
  draftEdited,
  formFromJson,
  jsonContextDiffers,
  jsonFromForm,
  newDraft,
  targetGroups,
  targetUnavailable,
  type CallTarget,
  type Draft,
} from '../benchForm'
import { stepBadge } from '../benchResult'
import { catalogFailure, divergenceNotice, runBlocker, sessionUsage } from '../benchSession'
import { useBench } from '../composables/useBench'
import { icons } from '../icons'
import BenchAgentBusy from './BenchAgentBusy.vue'
import BenchContextForm from './BenchContextForm.vue'
import BenchField from './BenchField.vue'
import BenchNotice from './BenchNotice.vue'
import BenchRunLine from './BenchRunLine.vue'
import BenchStatus from './BenchStatus.vue'
import BenchStepView from './BenchStepView.vue'
import BenchTag from './BenchTag.vue'
import Hint from './Hint.vue'
import SectionHeading from './strata/SectionHeading.vue'

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
  callRunning,
  generation,
  sessionContext,
  session,
  call,
  clearSession,
  acceptDiverged,
  callFailure: failure,
  unsaved,
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
// 每个调用上一次在目录里的样子。选中的工具不在现在的目录里时（换了 Key，目录在读取、读取失败或者没有它）
// 表单与草稿都留着，只是不能运行，见 targetUnavailable
const seen = new Map<string, CallTarget>()
watch(
  targets,
  (list) => {
    for (const t of list) seen.set(t.id, t)
  },
  { immediate: true },
)
const target = computed(
  () => targets.value.find((t) => t.id === targetId.value) ?? seen.get(targetId.value)!,
)
const unavailable = computed(() =>
  targetUnavailable(
    target.value,
    targets.value,
    tools.data.value ? 'ready' : tools.isError.value ? 'failed' : 'pending',
  ),
)
const toolsError = computed(() => (tools.isError.value ? catalogFailure(tools.error.value) : null))
const retryTools = computed(() => [
  {
    label: '重新读取',
    color: 'neutral' as const,
    loading: tools.isFetching.value,
    onClick: () => void tools.refetch(),
  },
])

// 每个调用一份草稿：切到别的调用再切回来时还在。只在内存里，可能有明文，不进浏览器存储
const drafts = shallowReactive(new Map<string, Draft>())
watchEffect(() => (unsaved.drafts = [...drafts.values()].some(draftEdited)))
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
// 这些说明都是上一个调用的，不能留在另一个调用的表单下面。真实模式的失败说明除外：可能已经执行了一部分，
// 时间线里又没有记录，清掉就再也看不到了，所以带着调用名留到下一次运行
watch(targetId, () => {
  formError.value = null
  if (!real.value) failure.value = null
})
function showJson() {
  const made = jsonFromForm(target.value, draft.value, sessionContext.value)
  if (!made.ok) {
    formError.value = made.error
    return
  }
  draft.value.text = made.text
  draft.value.base = made.text
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
    label: '接受并移除此步',
    color: 'neutral' as const,
    disabled: running.value,
    onClick: acceptDiverged,
  },
  {
    label: '清空当前会话',
    color: 'error' as const,
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
  if (running.value || unavailable.value) return
  const built = buildStep(target.value, draft.value, sessionContext.value)
  if (!built.ok) {
    formError.value = built.error
    return
  }
  formError.value = null
  // 真的发出去才清：表单写错了不算下一次运行，真实模式的失败说明还要留着
  failure.value = null
  const forTarget = target.value.id
  const outcome = await call([built.step], forTarget)
  if (outcome.kind === 'done') shownId.value = null
  else if (outcome.kind === 'failed') {
    // 说清楚是哪一个调用的：运行期间可能切到了别的调用，真实模式下切走之后这条说明也还留着
    failure.value =
      !real.value && targetId.value === forTarget
        ? outcome.message
        : `${forTarget}：${outcome.message}`
  }
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
  <div class="calls">
    <BenchNotice
      v-if="toolsError"
      class="calls-error"
      color="error"
      :title="toolsError"
      :actions="retryTools"
    />
    <div class="calls-columns">
      <nav class="calls-nav" aria-label="调用目录">
        <section v-for="group in groups" :key="group.value" class="target-group">
          <h3>{{ group.label }}</h3>
          <USkeleton v-if="group.value === 'tool' && tools.isPending.value" class="h-24 w-full" />
          <ul v-else>
            <li v-for="t in group.targets" :key="t.id">
              <button
                type="button"
                class="target"
                :class="{ selected: t.id === target.id }"
                :aria-current="t.id === target.id ? 'true' : undefined"
                @click="targetId = t.id"
              >
                <span class="target-id">{{ t.id }}</span>
                <BenchTag v-if="t.readOnly">只读</BenchTag>
                <BenchTag v-if="t.destructive" tone="warning">破坏性</BenchTag>
              </button>
            </li>
          </ul>
        </section>
      </nav>

      <div class="calls-form">
        <BenchContextForm />
        <form class="call-form" novalidate @submit.prevent="onSubmit">
          <div class="call-head">
            <h3>
              <code>{{ target.id }}</code>
              <BenchTag v-if="target.readOnly">只读</BenchTag>
              <BenchTag v-if="target.destructive" tone="warning">破坏性</BenchTag>
            </h3>
            <p v-if="target.description" class="text-muted">{{ target.description }}</p>
            <template v-if="target.group === 'tool'">
              <p class="text-muted">
                工具调用不带会话上下文，与真实 MCP 一致，按当前 Key 的全部权限读写。
              </p>
              <p v-if="app?.runtimeFamily === 'astrbot'" class="text-warning">
                请勿为群聊 Bot 接入 MCP：群成员可借工具读取当前 Key
                能读取的全部内容。此处仅测试工具本身。
              </p>
            </template>
            <template v-else-if="target.usesContext">
              <p v-if="draft.json" class="text-muted">
                JSON 模式仅发送此 JSON 中的 context，上方的会话上下文不生效。
              </p>
              <p v-else class="text-muted">此调用带上方的会话上下文。</p>
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
            <p v-else class="text-muted">此工具无参数</p>
            <p v-if="draft.json || target.fields?.length" class="note text-muted">
              字符串中可使用 <code>${run}</code> 与 <code>${expires}</code>，校验由服务端完成。
              <Hint>
                <code>${run}</code> 是每次运行不同的标记。<code>${expires}</code> 是 6
                小时后的时间，用于 valid_to。不合法的请求也会发出。
              </Hint>
            </p>
          </template>

          <div class="call-end">
            <div class="end-notes" tabindex="0" role="region" aria-label="运行提示">
              <BenchNotice
                v-if="contextDiffers"
                flush
                color="warning"
                title="此 JSON 中的 context 与上方的会话上下文不同：本次按 JSON 执行，未写 context 即不带。"
              />
              <BenchNotice v-if="unavailable" flush color="warning" :title="unavailable" />
              <BenchNotice v-if="formError" flush color="warning" :title="formError" />
              <BenchNotice v-if="failure" flush color="error" :title="failure" />
            </div>
            <BenchAgentBusy flush />

            <div class="call-actions">
              <UButton
                :type="real ? 'button' : 'submit'"
                :color="real ? 'error' : 'primary'"
                :icon="icons.preview"
                :loading="callRunning"
                :disabled="Boolean(unavailable || blocker || running)"
                @click="onRunClick"
              >
                {{ real ? '真实执行' : '运行' }}
              </UButton>
              <template v-if="target.hasBody && target.fields">
                <UButton
                  v-if="draft.json"
                  :icon="icons.form"
                  color="neutral"
                  variant="outline"
                  @click="showForm"
                >
                  使用表单
                </UButton>
                <UButton
                  v-else
                  :icon="icons.json"
                  color="neutral"
                  variant="outline"
                  @click="showJson"
                >
                  使用 JSON
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
          </div>
        </form>
      </div>

      <div class="calls-result">
        <section>
          <SectionHeading title="当前会话">
            <template #actions>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.clear"
                :disabled="running || !timeline.length"
                @click="clear"
              >
                清空
              </UButton>
            </template>
          </SectionHeading>
          <p class="usage">{{ usage }}</p>
          <BenchNotice
            v-if="diverged"
            color="warning"
            :title="diverged.title"
            :description="diverged.description"
            :actions="divergedActions"
          />
          <BenchNotice v-if="blocker" color="warning" :title="blocker" />
          <p role="status" class="run-status">{{ callRunning ? '运行中…' : '' }}</p>
          <ol v-if="timeline.length" class="timeline">
            <li v-for="entry in timeline" :key="entry.id">
              <button
                type="button"
                class="entry"
                :class="{ selected: entry.id === shown?.id }"
                :aria-current="entry.id === shown?.id ? 'true' : undefined"
                @click="shownId = entry.id"
              >
                <BenchStatus :badge="stepBadge(entry.step, 'call')" />
                <span class="entry-label">{{ entry.step.label }}</span>
                <BenchTag v-if="entry.kept">写入已保留</BenchTag>
                <BenchTag v-else-if="entry.removed" tone="warning">写入已移除</BenchTag>
                <span v-if="entry.step.raw !== null" class="entry-ms">
                  {{ entry.step.ms }} ms
                </span>
              </button>
            </li>
          </ol>
          <p v-else-if="!callRunning" class="empty">暂无调用</p>
          <p v-if="session.dropped" class="usage">
            更早的 {{ session.dropped }} 条不再显示，已保留的写入不受影响。
          </p>
        </section>

        <div v-if="shown" class="shown">
          <BenchRunLine :result="shown" />
          <BenchStepView :key="shown.id" :step="shown.step" :mode="mode" view="call" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calls {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.calls-error {
  margin-top: 12px;
  margin-right: 32px;
  margin-left: 32px;
}
/* 目录、表单、结果各自滚动：结果再长，也不用滚回去就能改参数、再运行一次 */
.calls-columns {
  flex: 1 1 0;
  display: grid;
  grid-template-columns: 17.5rem minmax(0, 1fr) minmax(0, 1.25fr);
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
}
.calls-nav,
.calls-form,
.calls-result {
  min-width: 0;
  overflow-y: auto;
}
.calls-nav,
.calls-form {
  border-right: 1px solid var(--ui-border);
}
.calls-nav {
  padding: 12px 12px 24px 26px;
}
.calls-form {
  padding: 12px 24px 0;
}
.calls-result {
  padding: 12px 32px 40px 24px;
}

.target-group + .target-group {
  margin-top: 14px;
}
.target-group h3 {
  padding: 0 6px 3px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.target {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0 8px;
  width: 100%;
  padding: 2px 6px;
  text-align: left;
}
.target:hover {
  background: var(--ui-bg-elevated);
}
.target:focus-visible,
.entry:focus-visible {
  outline-offset: -2px;
}
.target.selected,
.target.selected:hover,
.entry.selected,
.entry.selected:hover {
  --tag-muted: var(--strata-on-selected-muted);
  --tag-warning: var(--strata-on-selected);
  --status-error: var(--strata-on-selected);
  --status-warning: var(--strata-on-selected);
  --status-muted: var(--strata-on-selected-muted);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.target-id {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.call-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 12px;
}
.call-head {
  font-size: 13px;
  line-height: 1.6;
}
.call-head h3 {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  padding-bottom: 2px;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.note {
  font-size: 13px;
  line-height: 1.6;
}
/* 运行按钮贴在这一栏底部：参数再多也够得着。提示可能很长，自己滚动，不盖住表单、不把按钮挤走 */
.call-end {
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding: 4px 0 12px;
  background: var(--ui-bg);
  border-top: 1px solid var(--ui-border);
}
/* 矮窗口里按窗口高度算，高窗口里不超过十来行。没有提示时不占地方，也不留一个空的 Tab 停靠点 */
.end-notes {
  max-height: min(30dvh, 14rem);
  overflow-y: auto;
}
.end-notes:empty {
  display: none;
}
.end-notes:focus-visible {
  outline-offset: -2px;
}
.call-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
}

.usage {
  padding: 6px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.timeline {
  max-height: 16rem;
  overflow-y: auto;
  border-top: 1px solid var(--ui-border);
}
.timeline li {
  border-bottom: 1px solid var(--ui-border);
}
.entry {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  width: 100%;
  padding: 3px 6px;
  text-align: left;
}
.entry:hover {
  background: var(--ui-bg-elevated);
}
.entry-label {
  flex: 1 1 8em;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.entry-ms {
  font-size: 13px;
  line-height: 1.5;
  white-space: nowrap;
  opacity: 0.8;
}
/* 一直在，只换文字：读屏才念得到。没在运行时不占地方 */
.empty,
.run-status:not(:empty) {
  padding: 6px 0;
  color: var(--ui-text-muted);
}
.shown {
  margin-top: 20px;
}

/* 三栏放不下时目录放到上面，一行排几个；整页滚动，各栏不再自己滚 */
@media (max-width: 1240px) {
  .calls,
  .calls-columns {
    flex: 1 0 auto;
    min-height: 0;
  }
  .calls-columns {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .calls-nav,
  .calls-form,
  .calls-result {
    overflow-y: visible;
  }
  .calls-nav {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 24px;
    padding: 10px 32px 12px 26px;
    border-right: 0;
    border-bottom: 1px solid var(--ui-border);
  }
  .target-group + .target-group {
    margin-top: 0;
  }
  .target-group ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0 4px;
  }
  .target {
    width: auto;
  }
  .calls-form {
    padding-left: 32px;
  }
}
/* 窄屏：一栏 */
@media (max-width: 1023.98px) {
  .calls-error {
    margin-right: 16px;
    margin-left: 16px;
  }
  .calls-columns {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: none;
  }
  .calls-nav {
    padding: 8px 16px 10px 10px;
  }
  .calls-form {
    padding: 10px 16px 0;
    border-right: 0;
  }
  .calls-result {
    padding: 14px 16px 28px;
    border-top: 1px solid var(--strata-rule);
  }
}
</style>
