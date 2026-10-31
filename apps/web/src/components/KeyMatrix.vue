<script setup lang="ts">
import { ACCESS_CONTEXTS, type AccessContext, type KeyInfo } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, useId } from 'vue'

import { readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { KEY_MATRIX_STALE_TIME, keyMatrixKey } from '../appQueries'
import { isNarrowed } from '../apps'
import { accessContextLabels, accessContextShortLabels, originScopeLabels } from '../labels'
import Hint from './Hint.vue'
import AccessMatrix from './strata/AccessMatrix.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'

// 一个 Key 的权限范围：五种会话上下文各一根小岩芯，点哪根看哪根的矩阵。岩芯和矩阵的数据都来自接口，前端不算权限
const props = defineProps<{ spaceId: string; appId: string; keyInfo: KeyInfo }>()
const context = defineModel<AccessContext>('context', { required: true })

const matrix = useQuery({
  queryKey: computed(() => keyMatrixKey(props.spaceId, props.appId, props.keyInfo)),
  queryFn: ({ queryKey: [, sid, aid, kid] }) => api.keyMatrix(sid, aid, kid),
  staleTime: KEY_MATRIX_STALE_TIME,
})
const rowsOf = (c: AccessContext) =>
  matrix.data.value?.contexts.find((entry) => entry.context === c)?.rows ?? null
const current = computed(() =>
  matrix.data.value?.contexts.find((entry) => entry.context === context.value),
)
const groupName = useId()
</script>

<template>
  <section class="key-matrix">
    <SectionHeading title="权限范围">
      <template #hint>
        <Hint>
          实际权限按当前有效上限与应用配置计算。会话上下文由应用上报，只能收紧权限，不能放宽。「按
          URI
          读取」只能显式读取，不进入召回与启动加载。联系人层与情节层的「写」指对话抽取写入，不能按
          URI 直接写入。
        </Hint>
      </template>
      <template #actions>
        <span class="key-name" :title="keyInfo.name">{{ keyInfo.name }}</span>
      </template>
    </SectionHeading>

    <NoteLine v-if="isNarrowed(keyInfo)" class="key-note" tone="warning">
      当前有效范围小于签发范围，已按所有者当前角色收紧
    </NoteLine>

    <NoteLine v-if="matrix.isError.value" class="key-note" tone="error">
      {{ readFailure(matrix.error.value) }}
    </NoteLine>
    <USkeleton v-if="matrix.isPending.value" class="mt-3 h-72 w-full" />
    <template v-else-if="current">
      <div class="ctxs" role="radiogroup" aria-label="会话上下文">
        <label
          v-for="c in ACCESS_CONTEXTS"
          :key="c"
          class="ctx"
          :class="{ on: context === c }"
          :title="accessContextLabels[c]"
        >
          <input
            type="radio"
            :name="groupName"
            :checked="context === c"
            :aria-label="accessContextLabels[c]"
            @change="context = c"
          />
          <StrataCore :rows="rowsOf(c)" :width="40" :height="62" :label="accessContextLabels[c]" />
          <span>{{ accessContextShortLabels[c] }}</span>
        </label>
      </div>
      <AccessMatrix :rows="current.rows" />
      <p class="origin">{{ originScopeLabels[current.originScope] }}</p>
    </template>
  </section>
</template>

<style scoped>
.key-name {
  max-width: 18em;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-line.key-note {
  margin: 0;
  border-top: 0;
}
.ctxs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0 0 14px;
  border-bottom: 1px solid var(--ui-border);
}
.ctx {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 9px;
  padding: 9px 8px;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.ctx + .ctx {
  border-left: 1px solid var(--ui-border);
}
.ctx:hover {
  background: var(--ui-bg-muted);
  color: var(--ui-text);
}
.ctx input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.ctx:has(input:focus-visible) {
  outline: 2px solid var(--ui-text-highlighted);
  outline-offset: -2px;
}
.ctx span {
  white-space: nowrap;
}
.ctx.on,
.ctx.on:hover {
  --strata-frame: var(--strata-selected-frame);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
  font-weight: 600;
}
.origin {
  margin-top: 8px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
@media (max-width: 900px) {
  .ctx {
    flex-direction: column;
    align-items: flex-start;
    gap: 5px;
    padding: 7px 4px;
    font-size: 12px;
  }
  .ctx span {
    white-space: normal;
    line-height: 1.3;
  }
}
</style>
