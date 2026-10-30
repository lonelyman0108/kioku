<script setup lang="ts">
import { stepOpen } from '../benchScenarios'
import { useBench } from '../composables/useBench'
import { scopesSummary } from '../labels'
import BenchStepView from './BenchStepView.vue'

// 真实模式中途作废的运行。放在分页外面：这把 Key 没了、分页隐藏的时候，切到另一个分页的时候都看得到
const { abandoned, abandonedInFlight, dismissAbandoned } = useBench()
</script>

<template>
  <div v-if="abandonedInFlight || abandoned.length" class="space-y-3 text-sm">
    <UAlert
      v-if="abandonedInFlight"
      color="warning"
      variant="subtle"
      title="有一次真实运行中途作废了，请求还没回来：可能正在写入，结果回来后显示在这里。"
    />
    <section v-for="run in abandoned" :key="run.id" class="space-y-2">
      <UAlert
        color="warning"
        variant="subtle"
        :title="run.title"
        :description="run.description"
        close
        @update:open="(v) => !v && dismissAbandoned(run.id)"
      />
      <template v-if="run.result">
        <p class="text-xs text-muted">
          运行标记 <code>{{ run.result.run }}</code> · {{ run.result.whoami.app.name }} ·
          {{ scopesSummary(run.result.whoami.scopes) }}
        </p>
        <BenchStepView
          v-for="step in run.result.steps"
          :key="`${run.result.run}-${step.index}`"
          :step="step"
          mode="real"
          :view="run.view"
          :open="stepOpen(step, run.view)"
        />
      </template>
    </section>
  </div>
</template>
