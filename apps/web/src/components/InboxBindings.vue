<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useActivated } from '../composables/useActivated'
import Hint from './Hint.vue'
import SubjectBindings from './SubjectBindings.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'

// 账号绑定：等当前账号确认的绑定只有概览接口给，和概览共用一份缓存
const props = defineProps<{ spaceId: string }>()
const active = useActivated()
const overview = useQuery({
  queryKey: computed(() => ['overview', props.spaceId]),
  queryFn: () => api.overview(props.spaceId),
  enabled: active,
  staleTime: 60_000,
})
const items = computed(() => overview.data.value?.pendingBindings ?? [])
const total = computed(() => overview.data.value?.inbox.bindings ?? 0)
</script>

<template>
  <div>
    <SectionHeading title="账号绑定">
      <template #hint>
        <Hint>对方在 Bot 私聊中使用绑定码发起申请，确认后账号并入标记为本人的联系人。</Hint>
      </template>
    </SectionHeading>
    <NoteLine v-if="overview.isError.value && !overview.data.value" class="panel-note" tone="error">
      {{ overview.error.value instanceof ApiError ? overview.error.value.message : '读取失败' }}
    </NoteLine>
    <USkeleton v-else-if="overview.isPending.value" class="mt-3 h-24 w-full" />
    <p v-else-if="!items.length" class="panel-empty">暂无账号绑定申请</p>
    <template v-else>
      <p class="panel-lead">
        确认后，该账号的私聊视为本人对话，此操作不可撤销。如无法辨认，请拒绝。
      </p>
      <p v-if="total > items.length" class="panel-more">
        仅列出前 {{ items.length }} 个，处理后显示其余的。
      </p>
      <SubjectBindings :space-id="spaceId" :items="items" />
    </template>
  </div>
</template>

<style scoped>
.note-line.panel-note {
  margin: 10px 0 0;
  border-top: 0;
}
.panel-empty {
  padding: 22px 0;
  color: var(--ui-text-muted);
}
.panel-lead {
  padding-top: 12px;
  font-size: 14px;
}
.panel-more {
  font-size: 14px;
  color: var(--ui-text-muted);
}
</style>
