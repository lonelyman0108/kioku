<script setup lang="ts">
import { ACCESS_CONTEXTS, type AccessCell, type AccessContext } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { accessContextLabels, layerLabels, originScopeLabels, sensitivityLabels } from '../labels'

const props = defineProps<{ spaceId: string; appId: string; keyId: string }>()

const matrix = useQuery({
  queryKey: computed(() => ['key-matrix', props.spaceId, props.appId, props.keyId]),
  queryFn: () => api.keyMatrix(props.spaceId, props.appId, props.keyId),
})
const context = ref<AccessContext>('none')
const tabs = ACCESS_CONTEXTS.map((c) => ({ label: accessContextLabels[c], value: c }))
const current = computed(() => matrix.data.value?.contexts.find((c) => c.context === context.value))

// 一格里写什么：进召回的读、只能按 URI 读、写
function cellText(cell: AccessCell): string {
  const parts = [
    cell.read === 'recall' ? '读' : cell.read === 'explicit' ? '按 URI 读' : '',
    cell.write ? '写' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}
</script>

<template>
  <div class="space-y-3 text-sm">
    <UTabs v-model="context" :items="tabs" :content="false" size="xs" class="w-full" />
    <UAlert
      v-if="matrix.isError.value"
      color="error"
      variant="subtle"
      :title="matrix.error.value instanceof ApiError ? matrix.error.value.message : '读取失败'"
    />
    <USkeleton v-else-if="!current" class="h-48 w-full" />
    <template v-else>
      <p class="text-xs text-muted">
        {{ originScopeLabels[current.originScope] }}。「按 URI
        读」只能显式读取，不进召回与启动上下文；对象层与情节层的「写」指对话抽取能写进去，不能按 URI
        直接写。会话上下文由接入方上报，只能收紧、不能放宽。
      </p>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[28rem] border-collapse text-xs">
          <thead>
            <tr class="text-left text-muted">
              <th class="py-1 pr-2 font-normal">层</th>
              <th
                v-for="cell in current.rows[0]!.cells"
                :key="cell.sensitivity"
                class="px-2 py-1 font-normal"
              >
                {{ sensitivityLabels[cell.sensitivity] }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in current.rows" :key="row.layer" class="border-t border-default">
              <th class="py-1.5 pr-2 text-left font-normal">{{ layerLabels[row.layer] }}</th>
              <td
                v-for="cell in row.cells"
                :key="cell.sensitivity"
                class="px-2 py-1.5"
                :class="cell.read === 'none' && !cell.write ? 'text-dimmed' : ''"
              >
                {{ cellText(cell) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
