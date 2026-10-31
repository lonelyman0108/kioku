<script setup lang="ts">
import type { BenchRunResult } from '@kioku/contracts'

import { scopesSummary } from '../labels'

// 一次运行是什么：运行标记（真实模式下在变更记录里靠它对应写入）、应用、这次的权限范围
defineProps<{ result: Pick<BenchRunResult, 'run' | 'whoami'> }>()
</script>

<template>
  <p class="run-line">
    运行标记 <code>{{ result.run }}</code> · {{ result.whoami.app.name }} ·
    {{ scopesSummary(result.whoami.scopes) }}
  </p>
</template>

<style scoped>
.run-line {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
  line-height: 1.6;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
</style>
