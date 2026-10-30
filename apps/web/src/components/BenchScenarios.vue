<script setup lang="ts">
import { BENCH_MAX_REQUEST_BYTES, type BenchScenario } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, shallowRef, useTemplateRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatBytes } from '../backup'
import {
  formatScenario,
  parseScenario,
  plaintextIn,
  runSummary,
  runtimeMismatch,
  scenarioView,
  stepOpen,
  writingSteps,
  type PlaintextFinding,
} from '../benchScenarios'
import { REAL_MODE_CONSEQUENCES } from '../benchSession'
import { useBench } from '../composables/useBench'
import { saveFile } from '../download'
import { icons } from '../icons'
import { scopesSummary } from '../labels'
import BenchStepView from './BenchStepView.vue'

// 场景：一串步骤。选预设或导入 JSON，在文本框里编辑，运行，看断言结果。不存库，只在内存里：
// 里面可能有明文，不进浏览器存储
const {
  spaceId,
  app,
  real,
  mode,
  running,
  generation,
  execute,
  scenarioFailure: failure,
  scenarioOutcome: outcome,
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
  if (text.value.trim() && text.value !== loaded.value) {
    if (!window.confirm('文本框里改过的内容会被换掉，继续吗？')) return false
  }
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
    errors.value = ['读不出这个文件']
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
  if (parsed.ok) return parsed.scenario
  errors.value = parsed.errors
  return null
}

// 导出前检测明文，由用户决定是否继续
const exporting = shallowRef<{ scenario: BenchScenario; findings: PlaintextFinding[] } | null>(null)
function save(scenario: BenchScenario) {
  exporting.value = null
  const blob = new Blob([formatScenario(scenario)], { type: 'application/json' })
  saveFile(blob, `${scenario.id}.json`)
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
  <div class="space-y-4 text-sm">
    <p v-if="real" class="text-xs text-muted">
      场景是一串步骤，步骤自己带会话上下文，页面上的不起作用。步骤各自真实执行，读得到已经落库的写入，结果不进调用台的时间线。
    </p>
    <p v-else class="text-xs text-muted">
      场景是一串步骤，步骤自己带会话上下文，页面上的不起作用。它单独一个事务：不带调用台这次会话的写入，结果也不进那里的时间线。
    </p>
    <UAlert
      v-if="presets.isError.value && !presets.data.value"
      color="error"
      variant="subtle"
      :title="
        presets.error.value instanceof ApiError ? presets.error.value.message : '读取预设失败'
      "
    />
    <div class="flex flex-wrap items-end gap-2">
      <UFormField label="预设" class="w-full sm:w-72">
        <USelect
          :model-value="presetId"
          :items="presetItems"
          :loading="presets.isPending.value"
          placeholder="选一个预设"
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
        variant="subtle"
        @click="fileInput?.click()"
      >
        导入 JSON
      </UButton>
      <UButton
        :icon="icons.exportSpace"
        color="neutral"
        variant="subtle"
        :disabled="!text.trim()"
        @click="startExport"
      >
        导出 JSON
      </UButton>
    </div>
    <p v-if="preset?.description" class="text-xs text-muted">{{ preset.description }}</p>
    <details v-if="unusable.length" class="text-xs text-muted">
      <summary class="cursor-pointer">不适用于这个应用的预设（{{ unusable.length }}）</summary>
      <ul class="mt-1 space-y-1">
        <li v-for="c in unusable" :key="c.scenario.id">{{ c.scenario.title }}：{{ c.reason }}</li>
      </ul>
    </details>

    <UFormField label="场景 JSON">
      <UTextarea
        :model-value="text"
        :rows="14"
        placeholder="选一个预设，或者导入、粘贴 JSON"
        aria-label="场景 JSON"
        class="w-full font-mono"
        @update:model-value="(v) => edit(String(v))"
      />
    </UFormField>
    <UAlert
      v-if="mismatch"
      color="warning"
      variant="subtle"
      :title="`这个场景${mismatch}：结果可能不说明问题`"
    />
    <UAlert v-if="errors.length" color="error" variant="subtle" title="场景不合法">
      <template #description>
        <ul class="space-y-1 wrap-anywhere">
          <li v-for="(line, i) in errors" :key="i">{{ line }}</li>
        </ul>
      </template>
    </UAlert>
    <UAlert v-if="failure" color="error" variant="subtle" :title="failure" />
    <UButton
      :icon="icons.preview"
      :color="real ? 'error' : 'primary'"
      :loading="running"
      :disabled="!text.trim()"
      @click="startRun"
    >
      {{ real ? '真实执行这个场景' : '运行' }}
    </UButton>

    <section v-if="outcome && summary" class="space-y-2">
      <h3 class="font-medium">{{ outcome.title }}</h3>
      <UAlert :color="summary.color" variant="subtle" :title="summary.title" />
      <p class="text-xs text-muted">
        运行标记 <code>{{ outcome.result.run }}</code> · {{ outcome.result.whoami.app.name }} ·
        {{ scopesSummary(outcome.result.whoami.scopes) }}
      </p>
      <BenchStepView
        v-for="step in outcome.result.steps"
        :key="`${outcome.result.run}-${step.index}`"
        :step="step"
        :mode="mode"
        :view="view"
        :open="stepOpen(step, view)"
      />
    </section>

    <UModal
      :open="confirming !== null"
      title="在真实模式下运行这个场景？"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>
            「{{ confirming?.title }}」共 {{ confirming?.steps.length }} 步，其中
            {{ confirming ? writingSteps(confirming) : 0 }}
            步可能写库。步骤各自真实执行，中途失败或断开时已经写下的不会撤回：
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
      title="这个场景里有明文"
      @update:open="(v) => !v && (exporting = null)"
    >
      <template #body>
        <div class="space-y-2 text-sm">
          <p>导出的文件里会有这些内容的原文。打码只管服务端返回的结果，管不到场景本身：</p>
          <ul class="list-disc space-y-1 pl-5">
            <li v-for="finding in exporting?.findings ?? []" :key="finding.step">
              第 {{ finding.step }} 步「{{ finding.label }}」：{{ finding.what }}
            </li>
          </ul>
          <p>不要把它提交进仓库或发给别人。要去掉的话，先在文本框里改掉这些步骤。</p>
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
