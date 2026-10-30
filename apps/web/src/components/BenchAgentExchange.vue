<script setup lang="ts">
import type { BenchAgentLoop, BenchMode } from '@kioku/contracts'

import {
  agentPhaseLabels,
  argumentsText,
  attachedNote,
  callOpen,
  noticeColor,
  roundMeta,
  roundRun,
  type AgentExchange,
} from '../benchAgent'
import BenchStepView from './BenchStepView.vue'

// 一条用户消息的经过：生命周期事件、每一轮的助手文字与工具调用、turn.end。
// 文字一律原样显示，不渲染：模型的输出与记忆里的内容都不可信
defineProps<{ exchange: AgentExchange; mode: BenchMode; loop: BenchAgentLoop }>()

const PRE_CLASS =
  'mt-1 max-h-96 overflow-auto rounded bg-elevated p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap'
</script>

<template>
  <article class="space-y-3">
    <div class="flex flex-col items-end gap-1">
      <p class="max-w-[85%] rounded-lg bg-elevated px-3 py-2 wrap-anywhere whitespace-pre-wrap">
        {{ exchange.user }}
      </p>
      <p v-if="exchange.end && !exchange.inHistory" class="text-xs text-warning">
        这条消息没有进历史，模型之后看不到它。
      </p>
      <p v-else-if="exchange.attached" class="text-xs text-muted">{{ attachedNote(loop) }}</p>
    </div>

    <div v-if="exchange.lifecycle.length" class="space-y-2">
      <BenchStepView
        v-for="trace in exchange.lifecycle"
        :key="trace.step.index"
        :step="trace.step"
        :mode="mode"
        view="call"
        :open="callOpen(trace.step)"
      />
      <p v-if="mode === 'real'" class="text-xs text-muted">
        运行标记 <code>{{ exchange.lifecycle[0]?.run }}</code>
      </p>
    </div>

    <section v-for="(round, index) in exchange.rounds" :key="index" class="space-y-2">
      <details v-if="round.reasoning" class="text-xs">
        <summary class="cursor-pointer text-muted">模型的思考过程</summary>
        <pre :class="PRE_CLASS">{{ round.reasoning }}</pre>
      </details>
      <p v-if="round.text" class="wrap-anywhere whitespace-pre-wrap">{{ round.text }}</p>
      <p v-else-if="!round.calls.length" class="text-muted">（模型没有返回文字）</p>

      <div
        v-for="call in round.calls"
        :key="call.id"
        class="space-y-2 rounded-lg border border-default px-3 py-2"
      >
        <p class="flex flex-wrap items-center gap-2 text-xs">
          <span class="text-muted">模型要调</span>
          <code class="font-medium break-all">{{ call.name || '（没有名字）' }}</code>
          <UBadge v-if="call.trace?.kept" size="sm" color="neutral" variant="subtle">
            写入已保留
          </UBadge>
          <UBadge v-else-if="call.trace?.removed" size="sm" color="warning" variant="subtle">
            写入已去掉
          </UBadge>
        </p>
        <details class="text-xs">
          <summary class="cursor-pointer text-muted">参数</summary>
          <pre :class="PRE_CLASS">{{ argumentsText(call) }}</pre>
        </details>
        <BenchStepView
          v-if="call.trace"
          :step="call.trace.step"
          :mode="mode"
          view="call"
          :open="callOpen(call.trace.step)"
        />
        <p v-else-if="call.reply" class="text-xs wrap-anywhere text-warning">{{ call.reply }}</p>
        <p v-else class="text-xs text-muted">执行中…</p>
      </div>

      <p class="text-xs wrap-anywhere text-muted">
        {{ roundMeta(round) }}
        <template v-if="mode === 'real' && roundRun(round)">
          · 运行标记 <code>{{ roundRun(round) }}</code>
        </template>
      </p>
    </section>

    <div v-if="exchange.turnEnd" class="space-y-2">
      <BenchStepView
        :step="exchange.turnEnd.step"
        :mode="mode"
        view="call"
        :open="callOpen(exchange.turnEnd.step)"
      />
      <p v-if="mode === 'real'" class="text-xs text-muted">
        运行标记 <code>{{ exchange.turnEnd.run }}</code>
      </p>
    </div>
    <p v-if="exchange.turnEndNote" class="text-xs wrap-anywhere text-warning">
      {{ exchange.turnEndNote }}
    </p>

    <p v-if="exchange.phase" role="status" class="text-xs text-muted">
      {{ agentPhaseLabels[exchange.phase] }}
    </p>
    <UAlert
      v-if="exchange.notice"
      :color="noticeColor(exchange.end)"
      variant="subtle"
      class="wrap-anywhere"
      :title="exchange.notice"
    />
  </article>
</template>
