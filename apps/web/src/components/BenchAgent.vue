<script setup lang="ts">
import type { BenchScenario } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, nextTick, ref, shallowRef, useTemplateRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  AGENT_LOOP_DETAILS,
  AGENT_LOOP_NOTES,
  AGENT_UNAVAILABLE_NOTES,
  agentScenario,
  blockingDivergence,
  consentNeeded,
  consentText,
  DEFAULT_SYSTEM_PROMPT,
  droppedNote,
  sentToolCalls,
  usageSummary,
  type AgentConsent,
} from '../benchAgent'
import { formatScenario, plaintextIn, type PlaintextFinding } from '../benchScenarios'
import { divergenceNotice, NOT_API_FAILURE, runBlocker, sessionUsage } from '../benchSession'
import { useBench } from '../composables/useBench'
import { saveFile } from '../download'
import { icons } from '../icons'
import BenchAgentExchange from './BenchAgentExchange.vue'
import BenchContextForm from './BenchContextForm.vue'
import BenchNotice from './BenchNotice.vue'
import Hint from './Hint.vue'

// 模型对话：用实例设置里抽取模型的接口与 Key，让模型自己决定调哪个工具。循环由浏览器驱动（benchAgent.ts），
// 对话不存服务端、不进浏览器存储，状态在 useBench 里，换应用、Key、模式时清掉
const {
  spaceId,
  appId,
  keyId,
  real,
  mode,
  running,
  generation,
  agent,
  agentSending,
  agentStopping,
  sendToAgent,
  stopAgent,
  clearAgent,
  acceptAgentDiverged,
  consentTo,
} = useBench()

// 用不用得了、默认模型、接口的地址、这个运行时走哪种循环
const info = useQuery({
  queryKey: computed(() => ['bench-agent', spaceId.value, appId.value, keyId.value]),
  queryFn: () => api.benchAgent(spaceId.value, appId.value!, keyId.value!),
  enabled: computed(() => Boolean(appId.value && keyId.value)),
  // 实例设置可能刚改过：从那边配好模型回来时不能还显示没配
  staleTime: 0,
})
const infoError = computed(() => {
  if (!info.isError.value) return null
  const err = info.error.value
  return `读取模型代理状态失败：${err instanceof ApiError ? err.message : NOT_API_FAILURE}`
})
const retryInfo = computed(() => [
  {
    label: '重新读取',
    color: 'neutral' as const,
    variant: 'subtle' as const,
    loading: info.isFetching.value,
    onClick: () => void info.refetch(),
  },
])
const loop = computed(() => info.data.value?.loop ?? null)
const available = computed(() => info.data.value?.available === true)
const unavailable = computed(() => {
  const reason = info.data.value?.reason
  return reason ? AGENT_UNAVAILABLE_NOTES[reason] : null
})
// 没配模型、Key 解不开的只有实例管理员看得到，他们进得了实例设置
const unavailableActions = computed(() =>
  info.data.value?.reason === 'notAdmin'
    ? []
    : [
        {
          label: '去实例设置',
          color: 'neutral' as const,
          variant: 'subtle' as const,
          to: { name: 'settings' },
        },
      ],
)

// 模型名：没改过时跟着实例设置，清空了也退回实例设置的
const modelEdit = ref<string | null>(null)
const defaultModel = computed(() => info.data.value?.defaultModel ?? '')
const modelText = computed(() => modelEdit.value ?? defaultModel.value)
const model = computed(() => modelText.value.trim() || defaultModel.value)
const system = ref(DEFAULT_SYSTEM_PROMPT)

// 开始之前要点一下：内容会发给哪个接口的哪个模型，发什么内容。同一次对话不再问，接口地址、模型名、循环变了再问一次
const consent = computed<AgentConsent | null>(() =>
  loop.value
    ? { endpoint: info.data.value?.endpoint ?? null, model: model.value, loop: loop.value }
    : null,
)
const needsConsent = computed(() => !consent.value || consentNeeded(agent.value, consent.value))
const consentActions = computed(() => [
  {
    label: `发送至 ${model.value}，开始对话`,
    color: 'warning' as const,
    variant: 'subtle' as const,
    onClick: () => consent.value && consentTo(consent.value),
  },
])

const blocker = computed(() => runBlocker(agent.value.session, mode.value))
// 不说再运行一次：这条消息可能已经留在历史里，用户重打一遍的话模型看到的就是重复的请求
const diverged = computed(() => divergenceNotice(agent.value.session, '可继续发送下一条'))
// 运行期间不能接受或清空：结果回来时，第几步与这次的写入都是按发出请求时的日志算的
const divergedActions = computed(() => [
  {
    label: '接受并移除此步',
    color: 'neutral' as const,
    variant: 'subtle' as const,
    disabled: running.value,
    onClick: acceptAgentDiverged,
  },
  {
    label: '清空对话',
    color: 'error' as const,
    variant: 'subtle' as const,
    disabled: running.value,
    onClick: requestClear,
  },
])
const usage = computed(() => usageSummary(agent.value.usage))
const replayUsage = computed(() => sessionUsage(agent.value.session, mode.value))

const input = ref('')
const canSend = computed(
  () =>
    available.value &&
    Boolean(model.value) &&
    Boolean(input.value.trim()) &&
    !needsConsent.value &&
    !blocker.value &&
    !blockingDivergence(agent.value.session) &&
    !running.value,
)
async function send() {
  if (!canSend.value || !loop.value) return
  const text = input.value.trim()
  input.value = ''
  const finished = await sendToAgent(text, {
    loop: loop.value,
    system: system.value,
    model: model.value,
  })
  // 这条消息没有进历史（模型没有回复，或者中途作废）：文字放回去，可以再发一次。这时已经又写了别的就不动
  if (!finished?.inHistory && !input.value) input.value = text
}
// 回滚模式下 ⌘ 或 Ctrl + 回车发送。真实模式下只有点按钮才发，和调用台一样：模型会真的写
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || real.value) return
  event.preventDefault()
  void send()
}

// 轨迹变长时跟到最后：等模型的时候要看得到走到哪一步。输入区贴在底部，要留出它的高度
const end = useTemplateRef<HTMLElement>('end')
watch(agent, () => {
  if (agentSending.value) void nextTick(() => end.value?.scrollIntoView({ block: 'nearest' }))
})

// 存成场景：导出前检测明文，由用户决定是否继续
const hasCalls = computed(() => sentToolCalls(agent.value).length > 0)
const exporting = shallowRef<{
  scenario: BenchScenario
  findings: PlaintextFinding[]
  dropped: number
} | null>(null)
const exportNote = ref<string | null>(null)
function saveScenario(scenario: BenchScenario, dropped: number) {
  exporting.value = null
  const blob = new Blob([formatScenario(scenario)], { type: 'application/json' })
  saveFile(blob, `${scenario.id}.json`)
  exportNote.value = droppedNote(dropped)
}
function startExport() {
  const made = agentScenario(agent.value, new Date())
  if (!made) return
  if (!made.parsed.ok) {
    exportNote.value = `无法存为场景：${made.parsed.errors.join('；')}`
    return
  }
  const { scenario } = made.parsed
  const findings = plaintextIn(scenario)
  if (findings.length) exporting.value = { scenario, findings, dropped: made.dropped }
  else saveScenario(scenario, made.dropped)
}

const confirmingClear = ref(false)
function clear() {
  if (running.value) return
  confirmingClear.value = false
  clearAgent()
  exportNote.value = null
}
// 真实模式下对话里有过可能写库的运行时先确认：运行标记是活动里对应这些写入的唯一线索，清掉就没了。回滚模式什么都没留下
function requestClear() {
  if (agent.value.mayHaveWritten) confirmingClear.value = true
  else clear()
}
// 换了应用、Key 或模式时对话已经清掉了（useBench），这里的提示也不算数了。输入框里没发的留着
watch(generation, () => {
  exporting.value = null
  exportNote.value = null
  confirmingClear.value = false
})
</script>

<template>
  <div class="agent">
    <div v-if="info.isPending.value || infoError || unavailable" class="agent-state">
      <!-- 后台刷新失败时读到过的内容留着，错误放在上面 -->
      <BenchNotice v-if="infoError" color="error" :title="infoError" :actions="retryInfo" />
      <USkeleton v-if="info.isPending.value" class="h-24 w-full" />
      <BenchNotice
        v-else-if="unavailable"
        color="warning"
        :title="unavailable.title"
        :description="unavailable.description"
        :actions="unavailableActions"
      />
    </div>

    <div class="agent-columns">
      <aside v-if="available && loop" class="agent-side">
        <p class="side-note" :class="loop === 'approximate' ? 'text-warning' : 'text-muted'">
          {{ AGENT_LOOP_NOTES[loop] }}
          <Hint>{{ AGENT_LOOP_DETAILS[loop] }}</Hint>
        </p>
        <p v-if="real" class="side-note text-error">
          真实模式：模型调用写工具会真实写入，不会回滚。
          <Hint>每一轮下方显示运行标记，可在变更记录中对应这些写入。</Hint>
        </p>
        <BenchContextForm v-if="loop !== 'tools'" />
        <UFormField label="模型" help="接口与 Key 沿用实例设置的抽取模型，此处仅改模型名">
          <UInput
            :model-value="modelText"
            :placeholder="defaultModel"
            :disabled="running"
            aria-label="模型"
            class="w-full font-mono"
            @update:model-value="(v) => (modelEdit = String(v))"
          />
        </UFormField>
        <UFormField
          label="系统提示"
          :help="
            loop === 'tools'
              ? '此运行时没有 session.start'
              : 'session.start 的结果追加在后面一并发送'
          "
        >
          <UTextarea
            v-model="system"
            :rows="4"
            :disabled="running"
            aria-label="系统提示"
            class="w-full"
          />
        </UFormField>
      </aside>

      <div class="agent-main">
        <section v-if="loop && agent.exchanges.length" class="thread" aria-label="对话">
          <BenchAgentExchange
            v-for="exchange in agent.exchanges"
            :key="exchange.id"
            :exchange="exchange"
            :mode="mode"
            :loop="loop"
          />
          <div ref="end" class="scroll-mb-56" />
        </section>
        <p v-else-if="available && loop" class="thread empty">暂无消息</p>

        <div v-if="available && loop" class="composer">
          <BenchNotice
            v-if="consent && needsConsent && !agentSending"
            color="warning"
            title="发送前确认"
            :description="consentText(consent, mode)"
            :actions="consentActions"
          />
          <BenchNotice v-if="blocker" color="warning" :title="blocker" />
          <BenchNotice
            v-if="diverged"
            color="warning"
            :title="diverged.title"
            :description="diverged.description"
            :actions="divergedActions"
          />
          <BenchNotice
            v-if="exportNote"
            color="warning"
            :title="exportNote"
            close
            @update:open="(v) => !v && (exportNote = null)"
          />
          <UTextarea
            v-model="input"
            :rows="2"
            autoresize
            :maxrows="8"
            :placeholder="
              real ? '发给模型的消息（仅点击按钮发送）' : '发给模型的消息（⌘ 或 Ctrl + 回车发送）'
            "
            aria-label="发给模型的消息"
            class="w-full"
            @keydown="onKeydown"
          />
          <div class="composer-actions">
            <UButton
              :icon="icons.send"
              :color="real ? 'error' : 'primary'"
              :loading="agentSending"
              :disabled="!canSend"
              @click="send"
            >
              {{ real ? '发送（真实执行）' : '发送' }}
            </UButton>
            <UButton
              v-if="agentSending"
              :icon="icons.stop"
              color="neutral"
              variant="outline"
              :disabled="agentStopping"
              @click="stopAgent"
            >
              {{ agentStopping ? '正在停止' : '停止' }}
            </UButton>
            <UButton
              class="ml-auto"
              :icon="icons.exportSpace"
              color="neutral"
              variant="outline"
              :disabled="running || !hasCalls"
              @click="startExport"
            >
              存为场景
            </UButton>
            <UButton
              :icon="icons.clear"
              color="neutral"
              variant="outline"
              :disabled="running || !agent.exchanges.length"
              @click="requestClear"
            >
              清空对话
            </UButton>
          </div>
          <p v-if="agent.usage.rounds" class="usage">{{ usage }}</p>
          <p class="usage">{{ replayUsage }}</p>
        </div>
      </div>
    </div>

    <UModal
      :open="confirmingClear"
      title="清空此对话？"
      @update:open="(v) => !v && (confirmingClear = false)"
    >
      <template #body>
        <p class="text-sm">
          此对话在真实模式下可能已写入数据库，已写入的内容不会撤回。清空后，工具结果和运行标记不再显示：运行标记是在变更记录中对应这些写入的唯一线索，如需保留请先记下。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingClear = false">取消</UButton>
          <UButton color="error" @click="clear">清空</UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="exporting !== null"
      title="导出含明文的工具调用？"
      @update:open="(v) => !v && (exporting = null)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>导出文件将包含以下内容的原文。打码仅作用于服务端返回的结果，不覆盖模型写入的参数：</p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="finding in exporting?.findings ?? []" :key="finding.step">
              第 {{ finding.step }} 步「{{ finding.label }}」：{{ finding.what }}
            </li>
          </ul>
          <p>请勿提交到仓库或发送给他人。</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="exporting = null">取消</UButton>
          <UButton
            color="warning"
            @click="exporting && saveScenario(exporting.scenario, exporting.dropped)"
          >
            仍然导出
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.agent {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.agent-state {
  flex: none;
  padding: 12px 32px 0;
}
.agent-columns {
  flex: 1 1 0;
  display: flex;
  min-width: 0;
  min-height: 0;
}
/* 模型和系统提示放在右边一栏；左边是一列消息自己滚动，输入区在底部不动 */
.agent-main {
  order: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0 24px 0 32px;
}
.agent-side {
  order: 2;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 22rem;
  padding: 12px 32px 24px 24px;
  overflow-y: auto;
  border-left: 1px solid var(--ui-border);
}
.side-note {
  font-size: 13px;
  line-height: 1.6;
}
.thread {
  flex: 1 1 0;
  min-height: 8rem;
  padding-top: 12px;
  overflow-y: auto;
}
.thread.empty {
  color: var(--ui-text-muted);
}
.composer {
  flex: none;
  display: flex;
  flex-direction: column;
  max-height: 65%;
  padding: 10px 0 12px;
  overflow-y: auto;
  background: var(--ui-bg);
  border-top: 1px solid var(--strata-rule);
}
/* 输入区顶上已经有一条墨线，第一条提示不用再画 */
.composer :deep(.note-line:first-child) {
  min-height: 0;
  padding-top: 0;
  border-top: 0;
}
.composer-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
}
.usage {
  padding-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
/* 高度不够各自滚：整页滚动，输入区贴在底部 */
@media (max-width: 1240px) {
  .agent,
  .agent-columns {
    flex: 1 0 auto;
    min-height: 0;
  }
  .thread {
    flex: 1 0 auto;
    min-height: 0;
    overflow-y: visible;
  }
  .composer {
    position: sticky;
    bottom: 0;
    z-index: 10;
    max-height: none;
    overflow-y: visible;
  }
  .agent-side {
    overflow-y: visible;
  }
}
@media (max-width: 1023.98px) {
  .agent-state {
    padding: 12px 16px 0;
  }
  .agent-columns {
    flex-direction: column;
  }
  .agent-main {
    order: 2;
    padding: 0 16px;
  }
  .agent-side {
    order: 1;
    width: auto;
    padding: 10px 16px 14px;
    border-bottom: 1px solid var(--ui-border);
    border-left: 0;
  }
}
</style>
