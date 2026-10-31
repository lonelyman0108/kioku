<script setup lang="ts">
import { stepOpen } from '../benchScenarios'
import { useBench } from '../composables/useBench'
import BenchNotice from './BenchNotice.vue'
import BenchRunLine from './BenchRunLine.vue'
import BenchStepView from './BenchStepView.vue'

// 真实模式中途作废的运行。放在分页外面：这把 Key 没了、分页隐藏的时候，切到另一个分页的时候都看得到
const { abandoned, abandonedInFlight, dismissAbandoned } = useBench()
</script>

<template>
  <div v-if="abandonedInFlight || abandoned.length" class="abandoned">
    <BenchNotice
      v-if="abandonedInFlight"
      color="warning"
      title="一次真实运行已中途作废，请求尚未返回，可能正在写入。结果返回后显示在此处。"
    />
    <section v-for="run in abandoned" :key="run.id" class="abandoned-run">
      <BenchNotice
        color="warning"
        :title="run.title"
        :description="run.description"
        close
        @update:open="(v) => !v && dismissAbandoned(run.id)"
      />
      <template v-if="run.result">
        <BenchRunLine :result="run.result" />
        <BenchStepView
          v-for="step in run.result.steps"
          :key="`${run.result.run}-${step.index}`"
          :step="step"
          mode="real"
          :view="run.view"
          :open="stepOpen(step, run.view)"
          :number="step.index + 1"
        />
      </template>
    </section>
  </div>
</template>

<style scoped>
.abandoned {
  flex: none;
  max-height: 40vh;
  padding: 0 32px 16px;
  overflow-y: auto;
}
.abandoned-run + .abandoned-run {
  margin-top: 16px;
}
@media (max-width: 1240px) {
  .abandoned {
    max-height: none;
    overflow-y: visible;
  }
}
@media (max-width: 1023.98px) {
  .abandoned {
    padding: 0 16px 12px;
  }
}
</style>
