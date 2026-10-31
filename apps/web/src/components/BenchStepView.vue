<script setup lang="ts">
import type { BenchMode, BenchStepResult } from '@kioku/contracts'
import { computed } from 'vue'

import {
  changeItems,
  changesNotListed,
  errorNote,
  internalErrorText,
  sessionNotes,
  shownAssertions,
  stepBadge,
  stepKindLabels,
  turnNotBuffered,
  VECTOR_SKIPPED_NOTE,
  type StepView,
} from '../benchResult'
import { icons } from '../icons'
import BenchNotice from './BenchNotice.vue'
import BenchRawText from './BenchRawText.vue'
import BenchStatus from './BenchStatus.vue'
import BenchTag from './BenchTag.vue'
import UriPath from './strata/UriPath.vue'

// 一步的结果：调用台、场景、模型对话共用。原文一律经 BenchRawText 原样显示。
// number 是一串步骤里的第几步，和明文提示、重放分叉说的第几步对得上
const props = withDefaults(
  defineProps<{
    step: BenchStepResult
    mode: BenchMode
    view: StepView
    open?: boolean
    number?: number
  }>(),
  { open: true, number: undefined },
)

const badge = computed(() => stepBadge(props.step, props.view))
// 没有响应的步骤（跳过、没有执行、还没发出去就失败）没有原文可看
const responded = computed(() => props.step.raw !== null)
// 折叠时也看得到的：种类（步骤名就是种类时不重复）、状态码、耗时
const meta = computed(() => {
  const { kind, label, httpStatus, ms } = props.step
  return [
    ...(stepKindLabels[kind] === label ? [] : [stepKindLabels[kind]]),
    ...(httpStatus === null ? [] : [`HTTP ${httpStatus}`]),
    ...(responded.value ? [`${ms} ms`] : []),
  ].join(' · ')
})
const error = computed(() => errorNote(props.step, props.view))
const assertions = computed(() => shownAssertions(props.step, props.view))
const session = computed(() =>
  props.step.session ? sessionNotes(props.step.session, props.step.text) : null,
)
const changes = computed(() => (props.step.changes ? changeItems(props.step.changes) : []))
const captured = computed(() => Object.entries(props.step.captured))
const raw = computed(() => JSON.stringify(props.step.raw, null, 2))
const emptyText = computed(() =>
  props.step.kind === 'lifecycle' ? '（此步没有交给客户端的文字）' : '（空）',
)
</script>

<template>
  <details :open="open" class="step">
    <summary class="step-head">
      <span v-if="number !== undefined" class="step-number">{{ number }}</span>
      <BenchStatus :badge="badge" />
      <span class="step-label">{{ step.label }}</span>
      <!-- 按断言通过的步骤也可能报了错（预期之中，或者没带断言）：折叠时也看得出来 -->
      <BenchTag v-if="error && view === 'judged'">报错</BenchTag>
      <span class="step-meta">{{ meta }}</span>
    </summary>

    <div class="step-body">
      <p v-if="step.reason" class="text-muted">{{ step.reason }}</p>

      <BenchNotice
        v-if="step.internalError"
        color="error"
        title="服务内部错误"
        :description="internalErrorText(step)"
      />
      <p v-else-if="error" :class="error.alarming ? 'text-error' : 'text-muted'">
        {{ error.text }}
      </p>

      <ul v-if="assertions.length" class="assertions">
        <li v-for="(a, i) in assertions" :key="i" class="assertion">
          <UIcon
            :name="a.ok ? icons.passed : icons.failed"
            class="mt-[3px] size-3.5 shrink-0"
            :class="a.ok ? 'text-muted' : 'text-error'"
          />
          <span class="wrap-anywhere" :class="{ 'text-error': !a.ok }">{{ a.message }}</span>
        </li>
      </ul>

      <BenchRawText v-if="responded" title="收到的原文" :text="step.text || emptyText" open />

      <section v-if="step.uris?.length">
        <h4>结果中的 URI（{{ step.uris.length }}）</h4>
        <ul class="uris">
          <li v-for="uri in step.uris" :key="uri"><UriPath :uri="uri" wrap /></li>
        </ul>
      </section>

      <section v-if="session">
        <h4>会话开始</h4>
        <p class="note" :class="session.overLimit ? 'text-warning' : 'text-muted'">
          {{ session.size }}<template v-if="session.overLimit">：超出部分客户端可能截断</template>
        </p>
        <p v-if="session.omitted.length" class="note break-all text-muted">
          超出预算、未展开的节点：{{ session.omitted.join('、') }}
        </p>
        <p v-if="session.dropped.length" class="note text-warning">
          超出上限，未附上：{{ session.dropped.join('、') }}
        </p>
      </section>

      <p v-if="step.vectorSkipped" class="note vector text-warning">
        <UIcon :name="icons.vector" class="mt-[3px] size-3.5 shrink-0" />
        {{ VECTOR_SKIPPED_NOTE }}
      </p>

      <section v-if="responded">
        <h4>{{ mode === 'rollback' ? '真实执行时的改动' : '此步的改动' }}</h4>
        <p v-if="!step.changes" class="note text-muted">无法列出此步的改动</p>
        <template v-else>
          <p v-if="turnNotBuffered(step)" class="note text-muted">
            本轮未写入对话缓冲：未配置抽取模型，或当前 Key 无权写入联系人层与情节层。
          </p>
          <p v-if="!changes.length && !step.changes.turn" class="note text-muted">
            {{
              changesNotListed(step.changes)
                ? '无带标记的改动。联系人与对话缓冲不带标记，此模式下不列出。'
                : '无改动'
            }}
          </p>
          <ul v-else class="changes">
            <li v-for="(item, i) in changes" :key="i">
              <p class="change-line">
                <span>{{ item.action }}</span>
                <code v-if="item.target" class="break-all">{{ item.target }}</code>
                <BenchTag v-for="field in item.fields" :key="field">{{ field }}</BenchTag>
              </p>
              <p v-for="text in item.warnings" :key="text" class="note text-warning">
                {{ text }}
              </p>
              <p v-for="text in item.notes" :key="text" class="note text-muted">{{ text }}</p>
            </li>
            <li v-if="changesNotListed(step.changes)" class="note text-muted">
              联系人与对话缓冲不带标记，此模式下不列出。
            </li>
          </ul>
          <div v-if="step.changes.turn" class="turn">
            <p class="note text-muted">本轮（会话 {{ step.changes.turn.sessionId }}）：</p>
            <BenchRawText :text="`${step.changes.turn.user}\n---\n${step.changes.turn.reply}`" />
          </div>
        </template>
      </section>

      <section v-if="captured.length">
        <h4>capture 取到的值</h4>
        <ul class="captured">
          <li v-for="[name, value] in captured" :key="name">{{ name }} = {{ value }}</li>
        </ul>
      </section>

      <BenchRawText v-if="responded" title="原始响应" :text="raw" quiet />
    </div>
  </details>
</template>

<style scoped>
.step {
  border-bottom: 1px solid var(--ui-border);
}
.step-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  padding: 6px 0;
  list-style: none;
  cursor: pointer;
}
.step-head::-webkit-details-marker {
  display: none;
}
.step-head:hover {
  background: var(--ui-bg-muted);
}
.step-head:focus-visible {
  outline-offset: -2px;
}
/* 折叠的三角自己画：系统的三角在弹性布局里会单独占一行 */
.step-head::before {
  content: '';
  flex: none;
  align-self: flex-start;
  width: 0;
  height: 0;
  margin: 6px 2px 0 1px;
  border-style: solid;
  border-width: 4px 0 4px 6px;
  border-color: transparent transparent transparent var(--ui-text-muted);
}
.step[open] > .step-head::before {
  transform: rotate(90deg);
}
.step-number {
  flex: none;
  min-width: 1.5em;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  text-align: right;
  color: var(--ui-text-muted);
}
.step-label {
  flex: 1 1 10em;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.step-meta {
  margin-left: auto;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.step-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 14px 17px;
  font-size: 14px;
  line-height: 1.6;
}
h4 {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.6;
}
.note {
  font-size: 13px;
  line-height: 1.6;
}
.assertions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.assertion,
.vector {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.uris,
.captured {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
}
.captured {
  overflow-wrap: anywhere;
}
.changes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.change-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 8px;
  font-size: 13px;
  line-height: 1.6;
}
.turn {
  margin-top: 6px;
}
@media (max-width: 1023.98px) {
  .step-body {
    padding-left: 0;
  }
}
</style>
