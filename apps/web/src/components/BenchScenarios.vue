<script setup lang="ts">
import { BENCH_MAX_REQUEST_BYTES, type BenchScenario } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, shallowRef, useTemplateRef, watch, watchEffect } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import {
  formatScenario,
  parseScenario,
  plaintextIn,
  runSummary,
  runtimeMismatch,
  scenarioEdited,
  scenarioView,
  stepOpen,
  writingSteps,
  type PlaintextFinding,
} from '../benchScenarios'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { saveFile } from '../download'
import { icons } from '../icons'
import BenchAgentBusy from './BenchAgentBusy.vue'
import BenchNotice from './BenchNotice.vue'
import BenchRunLine from './BenchRunLine.vue'
import BenchStepView from './BenchStepView.vue'
import Hint from './Hint.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 场景：一串步骤。选预设或导入 JSON，在文本框里编辑，运行，看断言结果。不存库，只在内存里：
// 里面可能有明文，不进浏览器存储
const {
  spaceId,
  app,
  real,
  mode,
  running,
  scenarioRunning,
  generation,
  execute,
  scenarioFailure: failure,
  scenarioOutcome: outcome,
  unsaved,
} = useBench()

const presets = useQuery({
  queryKey: computed(() => ['bench-scenarios', spaceId.value]),
  queryFn: () => api.benchScenarios(spaceId.value),
})
const runtime = computed(() => app.value?.runtimeFamily ?? '')
const choices = computed(() =>
  (presets.data.value?.scenarios ?? []).map((scenario) => ({
    scenario,
    reason: runtimeMismatch(scenario, runtime.value),
  })),
)
const presetItems = computed(() =>
  choices.value
    .filter((c) => !c.reason)
    .map((c) => ({ label: c.scenario.title, value: c.scenario.id })),
)
const unusable = computed(() => choices.value.filter((c) => c.reason))
const presetId = ref<string | undefined>()
const preset = computed(
  () => choices.value.find((c) => c.scenario.id === presetId.value && !c.reason)?.scenario ?? null,
)

const text = ref('')
// 上次载入的内容：改过之后再载入别的要先问一声
const loaded = ref('')
const edited = computed(() => scenarioEdited(text.value, loaded.value))
watchEffect(() => (unsaved.scenario = edited.value))
const errors = ref<string[]>([])
function setText(next: string) {
  text.value = next
  errors.value = []
}
// 改过就不再是那个预设了：再选一次它就能换回原样
function edit(next: string) {
  setText(next)
  presetId.value = undefined
}

function replaceText(next: string): boolean {
  if (edited.value && !window.confirm('替换文本框中已修改的内容？修改将丢失。')) return false
  setText(next)
  loaded.value = next
  return true
}

function pickPreset(id: string) {
  const scenario = choices.value.find((c) => c.scenario.id === id)?.scenario
  if (scenario && replaceText(formatScenario(scenario))) presetId.value = id
}

// 导入的文件也放进文本框：有错的话错误显示出来，就地改
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清掉：同一个文件改完之后还能再选一次
  input.value = ''
  if (!file) return
  if (file.size > BENCH_MAX_REQUEST_BYTES) {
    errors.value = [`文件超过 ${formatBytes(BENCH_MAX_REQUEST_BYTES)} 的上限`]
    return
  }
  let content: string
  try {
    content = await file.text()
  } catch {
    errors.value = ['无法读取此文件']
    return
  }
  const parsed = parseScenario(content)
  if (!replaceText(parsed.ok ? formatScenario(parsed.scenario) : content)) return
  presetId.value = undefined
  if (!parsed.ok) errors.value = parsed.errors
}

// 文本框里的场景不适用于这个应用时只提醒，不拦：它是用户自己选的，也不会比别的调用多拿到权限
const mismatch = computed(() => {
  const parsed = parseScenario(text.value)
  return parsed.ok ? runtimeMismatch(parsed.scenario, runtime.value) : null
})

function validScenario(): BenchScenario | null {
  const parsed = parseScenario(text.value)
  // 成功的话清掉之前的错误：文件过大这类报错不来自文本框，文本框一直没动也要清
  errors.value = parsed.ok ? [] : parsed.errors
  return parsed.ok ? parsed.scenario : null
}

// 导出前检测明文，由用户决定是否继续
const exporting = shallowRef<{ scenario: BenchScenario; findings: PlaintextFinding[] } | null>(null)
function save(scenario: BenchScenario) {
  exporting.value = null
  const blob = new Blob([formatScenario(scenario)], { type: 'application/json' })
  saveFile(blob, `${scenario.id}.json`)
  // 存进文件了：离开页面、载入别的场景都不用再问
  loaded.value = text.value
}
function startExport() {
  const scenario = validScenario()
  if (!scenario) return
  const findings = plaintextIn(scenario)
  if (findings.length) exporting.value = { scenario, findings }
  else save(scenario)
}

const view = computed(() => scenarioView({ probe: outcome.value?.probe ?? false }))
const summary = computed(() =>
  outcome.value ? runSummary(outcome.value.result, view.value) : null,
)

// 真实模式下运行同样要确认：切模式时确认的是这把 Key，这里确认的是这一串步骤
const confirming = shallowRef<BenchScenario | null>(null)

// 换了应用、Key 或模式时清掉结果：它们属于别的 Key 或别的模式。文本框里的场景留着，换把 Key 再跑是常见的用法
watch(generation, () => {
  outcome.value = null
  failure.value = null
  confirming.value = null
})
// 选中的预设不适用于新的应用时不再显示成选中
watch(runtime, () => {
  if (!preset.value) presetId.value = undefined
})

async function runScenario(scenario: BenchScenario) {
  confirming.value = null
  failure.value = null
  // 上一次的结果不留着：这次失败时不能让人以为下面的还是这次的
  outcome.value = null
  // 不带调用台这次会话的重放，结果也不进它的时间线。回滚模式下单独一个事务，真实模式下步骤各自真实执行
  const done = await execute(scenario.steps, {
    label: scenario.title,
    view: scenarioView(scenario),
  })
  if (done.kind === 'done') {
    outcome.value = { title: scenario.title, probe: scenario.probe === true, result: done.result }
  } else if (done.kind === 'failed') {
    failure.value = done.message
  }
}

function startRun() {
  if (running.value) return
  const scenario = validScenario()
  if (!scenario) return
  if (real.value) confirming.value = scenario
  else void runScenario(scenario)
}
</script>

<template>
  <div class="scenarios">
    <div class="scenario-source">
      <p v-if="real" class="scenario-note">
        场景是一串步骤，步骤各自真实执行。
        <Hint>
          步骤自带会话上下文，页面上的不生效。步骤可读取已落库的写入，结果不进入调用台的时间线。
        </Hint>
      </p>
      <p v-else class="scenario-note">
        场景是一串步骤，在单独的事务中运行。
        <Hint>
          步骤自带会话上下文，页面上的不生效。不带调用台当前会话的写入，结果也不进入其时间线。
        </Hint>
      </p>
      <BenchNotice
        v-if="presets.isError.value"
        color="error"
        :title="
          presets.error.value instanceof ApiError ? presets.error.value.message : '读取预设失败'
        "
      />
      <div class="scenario-pick">
        <UFormField label="预设" class="min-w-0 flex-[1_1_14rem]">
          <USelect
            :model-value="presetId"
            :items="presetItems"
            :loading="presets.isPending.value"
            placeholder="选择预设"
            aria-label="预设"
            class="w-full"
            @update:model-value="(v) => pickPreset(String(v))"
          />
        </UFormField>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="hidden"
          aria-label="导入场景文件"
          @change="onFile"
        />
        <UButton
          :icon="icons.importSpace"
          color="neutral"
          variant="outline"
          @click="fileInput?.click()"
        >
          导入 JSON
        </UButton>
        <UButton
          :icon="icons.exportSpace"
          color="neutral"
          variant="outline"
          :disabled="!text.trim()"
          @click="startExport"
        >
          导出 JSON
        </UButton>
      </div>
      <p v-if="preset?.description" class="scenario-note">{{ preset.description }}</p>
      <details v-if="unusable.length" class="unusable">
        <summary>不适用于当前应用的预设（{{ unusable.length }}）</summary>
        <ul>
          <li v-for="c in unusable" :key="c.scenario.id">{{ c.scenario.title }}：{{ c.reason }}</li>
        </ul>
      </details>

      <UFormField label="场景 JSON">
        <UTextarea
          :model-value="text"
          :rows="14"
          placeholder="选择预设，或导入、粘贴 JSON"
          aria-label="场景 JSON"
          class="w-full font-mono"
          :ui="{ base: 'lg:min-h-[24rem]' }"
          @update:model-value="(v) => edit(String(v))"
        />
      </UFormField>

      <div class="scenario-end">
        <div class="end-notes">
          <BenchNotice
            v-if="mismatch"
            color="warning"
            :title="`此场景${mismatch}，结果可能没有参考价值`"
          />
          <BenchNotice v-if="errors.length" color="error" title="场景不合法">
            <template #description>
              <span v-for="(line, i) in errors" :key="i" class="block wrap-anywhere">
                {{ line }}
              </span>
            </template>
          </BenchNotice>
          <BenchNotice v-if="failure" color="error" :title="failure" />
        </div>
        <BenchAgentBusy />
        <UButton
          :icon="icons.preview"
          :color="real ? 'error' : 'primary'"
          :loading="scenarioRunning"
          :disabled="!text.trim() || running"
          @click="startRun"
        >
          {{ real ? '真实执行此场景' : '运行' }}
        </UButton>
      </div>
    </div>

    <div class="scenario-result">
      <section v-if="outcome && summary">
        <SectionHeading :title="outcome.title" />
        <p class="summary" :class="`tone-${summary.color}`">{{ summary.title }}</p>
        <BenchRunLine :result="outcome.result" />
        <BenchStepView
          v-for="step in outcome.result.steps"
          :key="`${outcome.result.run}-${step.index}`"
          :step="step"
          :mode="mode"
          :view="view"
          :open="stepOpen(step, view)"
          :number="step.index + 1"
        />
      </section>
      <template v-else>
        <SectionHeading title="运行结果" />
        <p v-if="scenarioRunning" role="status" class="empty">运行中…</p>
        <p v-else class="empty">暂无结果</p>
      </template>
    </div>

    <UModal
      :open="confirming !== null"
      title="在真实模式下运行此场景？"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>
            「{{ confirming?.title }}」共 {{ confirming?.steps.length }} 步，其中
            {{ confirming ? writingSteps(confirming) : 0 }}
            步可能写入数据库。步骤各自真实执行，中途失败或断开时，已写入的内容不会撤回：
          </p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="line in REAL_MODE_CONSEQUENCES" :key="line">{{ line }}</li>
          </ul>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirming = null">取消</UButton>
          <UButton color="error" @click="confirming && runScenario(confirming)">真实执行</UButton>
        </div>
      </template>
    </UModal>

    <UModal
      :open="exporting !== null"
      title="导出含明文的场景？"
      @update:open="(v) => !v && (exporting = null)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>导出文件将包含以下内容的原文。打码仅作用于服务端返回的结果，不覆盖场景本身：</p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="finding in exporting?.findings ?? []" :key="finding.step">
              第 {{ finding.step }} 步「{{ finding.label }}」：{{ finding.what }}
            </li>
          </ul>
          <p>请勿提交到仓库或发送给他人。如需去除，请先在文本框中修改这些步骤。</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="exporting = null">取消</UButton>
          <UButton color="warning" @click="exporting && save(exporting.scenario)">
            仍然导出
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* 左边写场景，右边是步骤列表，各自滚动：步骤再多也不用滚回去就能改了再跑 */
.scenarios {
  flex: 1 1 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr);
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
}
.scenario-source {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 24px 0 32px;
  overflow-y: auto;
  border-right: 1px solid var(--ui-border);
}
.scenario-result {
  min-width: 0;
  padding: 12px 32px 40px 24px;
  overflow-y: auto;
}
.scenario-note {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.scenario-pick {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}
.unusable {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.unusable > summary {
  cursor: pointer;
}
.unusable > summary::marker {
  font-size: 0.8em;
}
.unusable ul {
  padding-top: 2px;
}
/* 运行按钮贴在这一栏底部：场景再长也够得着。错误可能有很多行，自己滚动，不盖住文本框、不把按钮挤走 */
.scenario-end {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  padding: 8px 0 12px;
  background: var(--ui-bg);
}
.end-notes {
  max-height: 40dvh;
  overflow-y: auto;
}
.scenario-end > button {
  align-self: flex-start;
}
.summary {
  padding-top: 8px;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.tone-error {
  color: var(--ui-error);
}
.tone-warning {
  color: var(--ui-warning);
}
.empty {
  padding: 6px 0;
  color: var(--ui-text-muted);
}
/* 两栏放得下，但高度不够各自滚：整页滚动 */
@media (max-width: 1240px) {
  .scenarios {
    flex: 1 0 auto;
    grid-template-rows: auto;
    min-height: 0;
  }
  .scenario-source,
  .scenario-result {
    overflow-y: visible;
  }
}
@media (max-width: 1023.98px) {
  .scenarios {
    grid-template-columns: minmax(0, 1fr);
  }
  .scenario-source {
    padding: 10px 16px 0;
    border-right: 0;
  }
  .scenario-result {
    padding: 14px 16px 28px;
    border-top: 1px solid var(--strata-rule);
  }
}
</style>
