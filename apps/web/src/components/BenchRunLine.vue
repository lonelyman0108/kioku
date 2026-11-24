<script setup lang="ts">
import type { BenchRunResult, WhoAmI } from '@kioku/contracts'
import { computed } from 'vue'

import { scopesSummary } from '../labels'

type WhoAmISummary = Pick<WhoAmI, 'client' | 'scopes'> &
  Partial<Pick<WhoAmI, 'persona' | 'linkedCircles' | 'resolvedFacets' | 'vocabulary'>>

// 一次运行是什么：运行标记（真实模式下在变更记录里靠它对应写入）、客户端、人格、关联圈、语境与权限范围
const props = defineProps<{
  result: Pick<BenchRunResult, 'run'> & { whoami: WhoAmISummary }
}>()

const linkedText = computed(() => {
  const linked = props.result.whoami.linkedCircles ?? []
  if (!linked.length) return null
  return linked
    .map(
      (c) =>
        `${c.name ?? c.slug ?? c.id.slice(0, 8)}（${c.mode === 'read_write' ? '读写' : '只读'}）`,
    )
    .join('、')
})

const resolvedFacetsText = computed(() => {
  const facets = props.result.whoami.resolvedFacets
  if (!facets) return null
  const dims = props.result.whoami.vocabulary ?? []
  const parts: string[] = []
  for (const [key, slugs] of Object.entries(facets)) {
    if (!slugs.length) continue
    const dim = dims.find((d) => d.key === key)
    const dimLabel = dim?.name ?? key
    const termLabels = slugs.map((s) => dim?.terms.find((t) => t.slug === s)?.label ?? s)
    parts.push(`${dimLabel}:${termLabels.join('/')}`)
  }
  return parts.length ? parts.join(' · ') : null
})
</script>

<template>
  <p class="run-line">
    运行标记 <code>{{ result.run }}</code> · {{ result.whoami.client.name }} ·
    {{ scopesSummary(result.whoami.scopes)
    }}<template v-if="result.whoami.persona"> · 人格 {{ result.whoami.persona.name }}</template
    ><template v-if="linkedText"> · 关联圈 {{ linkedText }}</template
    ><template v-if="resolvedFacetsText"> · 语境 {{ resolvedFacetsText }}</template>
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
