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

// 一步的结果：调用台、场景共用。原文一律放在 <pre> 里原样显示，不渲染、不去空白
const props = withDefaults(
  defineProps<{ step: BenchStepResult; mode: BenchMode; view: StepView; open?: boolean }>(),
  { open: true },
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
  props.step.kind === 'lifecycle' ? '（这一步没有交给宿主的文字）' : '（空）',
)
const PRE_CLASS =
  'mt-2 max-h-96 overflow-auto rounded bg-elevated p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap'
</script>

<template>
  <details :open="open" class="rounded-lg border border-default px-3 py-2 text-sm">
    <!-- 里面都是行内元素：换成弹性布局的话，窄屏上折叠的三角会单独占一行 -->
    <summary class="cursor-pointer leading-6 *:mr-2 *:align-middle">
      <UBadge :color="badge.color" :icon="badge.icon" variant="subtle" size="sm">
        {{ badge.label }}
      </UBadge>
      <span class="font-medium break-all">{{ step.label }}</span>
      <!-- 按断言通过的步骤也可能报了错（预期之中，或者没带断言）：折叠时也看得出来 -->
      <UBadge v-if="error && view === 'judged'" color="neutral" variant="subtle" size="sm">
        报错
      </UBadge>
      <span class="inline-block text-xs text-muted">{{ meta }}</span>
    </summary>

    <div class="mt-3 space-y-3">
      <p v-if="step.reason" class="text-muted">{{ step.reason }}</p>

      <UAlert
        v-if="step.internalError"
        color="error"
        variant="subtle"
        title="服务内部错误"
        :description="internalErrorText(step)"
      />
      <p v-else-if="error" :class="error.alarming ? 'text-error' : 'text-muted'">
        {{ error.text }}
      </p>

      <ul v-if="assertions.length" class="space-y-1">
        <li v-for="(a, i) in assertions" :key="i" class="flex items-start gap-1.5 text-xs">
          <UIcon
            :name="a.ok ? icons.passed : icons.failed"
            class="mt-0.5 size-3.5 shrink-0"
            :class="a.ok ? 'text-success' : 'text-error'"
          />
          <span class="wrap-anywhere">{{ a.message }}</span>
        </li>
      </ul>

      <details v-if="responded" open>
        <summary class="cursor-pointer font-medium">收到的原文</summary>
        <pre :class="PRE_CLASS">{{ step.text || emptyText }}</pre>
      </details>

      <section v-if="step.uris?.length" class="space-y-1">
        <h4 class="font-medium">结果里的 URI（{{ step.uris.length }}）</h4>
        <ul class="font-mono text-xs break-all">
          <li v-for="uri in step.uris" :key="uri">{{ uri }}</li>
        </ul>
      </section>

      <section v-if="session" class="space-y-1">
        <h4 class="font-medium">会话开始</h4>
        <p class="text-xs" :class="session.overLimit ? 'text-warning' : 'text-muted'">
          {{ session.size }}<template v-if="session.overLimit">：超出的部分宿主可能截断</template>
        </p>
        <p v-if="session.omitted.length" class="text-xs break-all text-muted">
          超出预算、没有展开的节点：{{ session.omitted.join('、') }}
        </p>
        <p v-if="session.dropped.length" class="text-xs text-warning">
          放不下，没有附上：{{ session.dropped.join('、') }}
        </p>
      </section>

      <p v-if="step.vectorSkipped" class="flex items-start gap-1.5 text-xs text-warning">
        <UIcon :name="icons.vector" class="mt-0.5 size-3.5 shrink-0" />
        {{ VECTOR_SKIPPED_NOTE }}
      </p>

      <section v-if="responded" class="space-y-1">
        <h4 class="font-medium">{{ mode === 'rollback' ? '真执行会改什么' : '这一步改了什么' }}</h4>
        <p v-if="!step.changes" class="text-xs text-muted">这一步的改动列不出来。</p>
        <template v-else>
          <p v-if="turnNotBuffered(step)" class="text-xs text-muted">
            这一轮没有写进对话缓冲：没配抽取模型，或者这把 Key 写不了对象层与情节层。
          </p>
          <p v-if="!changes.length && !step.changes.turn" class="text-xs text-muted">
            {{
              changesNotListed(step.changes)
                ? '没有带标记的改动。对象与对话缓冲没有标记，这个模式不列。'
                : '没有改动。'
            }}
          </p>
          <ul v-else class="space-y-1.5">
            <li v-for="(item, i) in changes" :key="i" class="space-y-0.5">
              <p class="flex flex-wrap items-center gap-1.5 text-xs">
                <span>{{ item.action }}</span>
                <code v-if="item.target" class="break-all">{{ item.target }}</code>
                <UBadge
                  v-for="field in item.fields"
                  :key="field"
                  size="sm"
                  color="neutral"
                  variant="subtle"
                >
                  {{ field }}
                </UBadge>
              </p>
              <p v-for="text in item.warnings" :key="text" class="text-xs text-warning">
                {{ text }}
              </p>
              <p v-for="text in item.notes" :key="text" class="text-xs text-muted">{{ text }}</p>
            </li>
            <li v-if="changesNotListed(step.changes)" class="text-xs text-muted">
              对象与对话缓冲没有标记，这个模式不列。
            </li>
          </ul>
          <div v-if="step.changes.turn" class="text-xs">
            <p class="text-muted">这一轮（会话 {{ step.changes.turn.sessionId }}）：</p>
            <pre :class="PRE_CLASS">{{
              `${step.changes.turn.user}\n---\n${step.changes.turn.reply}`
            }}</pre>
          </div>
        </template>
      </section>

      <section v-if="captured.length" class="space-y-1">
        <h4 class="font-medium">capture 取到的</h4>
        <ul class="font-mono text-xs break-all">
          <li v-for="[name, value] in captured" :key="name">{{ name }} = {{ value }}</li>
        </ul>
      </section>

      <details v-if="responded">
        <summary class="cursor-pointer text-muted">原始响应</summary>
        <pre :class="PRE_CLASS">{{ raw }}</pre>
      </details>
    </div>
  </details>
</template>
