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
import BenchNotice from './BenchNotice.vue'
import BenchRawText from './BenchRawText.vue'
import BenchStepView from './BenchStepView.vue'
import BenchTag from './BenchTag.vue'

// 一条用户消息的经过：生命周期事件、每一轮的助手文字与工具调用、turn.end。
// 文字一律原样显示，不渲染：模型的输出与记忆里的内容都不可信
defineProps<{ exchange: AgentExchange; mode: BenchMode; loop: BenchAgentLoop }>()
</script>

<template>
  <article class="exchange">
    <div class="turn">
      <span class="role">用户</span>
      <p class="message user">{{ exchange.user }}</p>
      <p v-if="exchange.end && !exchange.inHistory" class="note text-warning">
        此消息未进入历史，模型后续不可见。
      </p>
      <p v-else-if="exchange.attached" class="note text-muted">{{ attachedNote(loop) }}</p>
    </div>

    <div v-if="exchange.lifecycle.length" class="turn">
      <span class="role">事件</span>
      <BenchStepView
        v-for="trace in exchange.lifecycle"
        :key="trace.step.index"
        :step="trace.step"
        :mode="mode"
        view="call"
        :open="callOpen(trace.step)"
      />
      <p v-if="mode === 'real'" class="note text-muted">
        运行标记 <code>{{ exchange.lifecycle[0]?.run }}</code>
      </p>
    </div>

    <section v-for="(round, index) in exchange.rounds" :key="index" class="turn">
      <span class="role">模型</span>
      <BenchRawText v-if="round.reasoning" title="模型的思考过程" :text="round.reasoning" quiet />
      <p v-if="round.text" class="message">{{ round.text }}</p>
      <p v-else-if="round.refusal" class="message text-warning">
        模型拒绝回答：{{ round.refusal }}
      </p>
      <p v-else-if="!round.calls.length" class="text-muted">（模型未返回文字）</p>

      <div v-for="call in round.calls" :key="call.id" class="call">
        <p class="call-line">
          <span class="text-muted">模型请求调用</span>
          <code class="call-name">{{ call.name || '（无名称）' }}</code>
          <BenchTag v-if="call.trace?.kept">写入已保留</BenchTag>
          <BenchTag v-else-if="call.trace?.removed" tone="warning">写入已移除</BenchTag>
        </p>
        <BenchRawText title="参数" :text="argumentsText(call)" quiet />
        <BenchStepView
          v-if="call.trace"
          :step="call.trace.step"
          :mode="mode"
          view="call"
          :open="callOpen(call.trace.step)"
        />
        <p v-else-if="call.reply" class="note wrap-anywhere text-warning">{{ call.reply }}</p>
        <p v-else class="note text-muted">执行中…</p>
      </div>

      <p class="note wrap-anywhere text-muted">
        {{ roundMeta(round) }}
        <template v-if="mode === 'real' && roundRun(round)">
          · 运行标记 <code>{{ roundRun(round) }}</code>
        </template>
      </p>
    </section>

    <div v-if="exchange.turnEnd" class="turn">
      <span class="role">事件</span>
      <BenchStepView
        :step="exchange.turnEnd.step"
        :mode="mode"
        view="call"
        :open="callOpen(exchange.turnEnd.step)"
      />
      <p v-if="mode === 'real'" class="note text-muted">
        运行标记 <code>{{ exchange.turnEnd.run }}</code>
      </p>
    </div>
    <p v-if="exchange.turnEndNote" class="note end-note wrap-anywhere text-warning">
      {{ exchange.turnEndNote }}
    </p>

    <p v-if="exchange.phase" role="status" class="note end-note text-muted">
      {{ agentPhaseLabels[exchange.phase] }}
    </p>
    <BenchNotice
      v-if="exchange.notice"
      class="end-note"
      :color="noticeColor(exchange.end)"
      :title="exchange.notice"
    />
  </article>
</template>

<style scoped>
/* 一列消息：左边窄窄一列写是谁，右边是内容。一条消息的经过之间用线分开，不用气泡 */
.exchange {
  --role-width: 2.5rem;
  border-top: 1px solid var(--strata-rule);
  font-size: 14px;
  line-height: 1.6;
}
.turn {
  display: grid;
  grid-template-columns: var(--role-width) minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 6px;
  padding: 8px 0;
}
.turn + .turn {
  border-top: 1px solid var(--ui-border);
}
.turn > * {
  grid-column: 2;
  min-width: 0;
}
.turn > .role {
  grid-column: 1;
  grid-row: 1;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-text-muted);
}
.message {
  max-width: 52em;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message.user {
  font-weight: 500;
}
.note {
  font-size: 13px;
  line-height: 1.6;
}
.end-note {
  margin-left: calc(var(--role-width) + 8px);
  padding-bottom: 8px;
}
/* 工具调用退后一级，靠一条竖线归到这一轮下面 */
.call {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
  border-left: 1px solid var(--ui-border-accented);
}
.call-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  font-size: 13px;
  line-height: 1.6;
}
.call-name {
  font-weight: 500;
  word-break: break-all;
}
@media (max-width: 639.98px) {
  .turn {
    grid-template-columns: minmax(0, 1fr);
  }
  .turn > * {
    grid-column: 1;
  }
  .turn > .role {
    grid-row: auto;
  }
  .end-note {
    margin-left: 0;
  }
}
</style>
