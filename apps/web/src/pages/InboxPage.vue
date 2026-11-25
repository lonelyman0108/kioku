<script setup lang="ts">
import type { ApplySuggestionRequest } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import DreamSuggestionCard from '../components/DreamSuggestionCard.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import PageHead from '../components/ui/PageHead.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { dreamOutcomeLabels } from '../labels'
import { settingsRoute } from '../routes'
import { formatRelative, formatTime } from '../time'

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()

const inboxQuery = useQuery({
  queryKey: ['inbox'] as const,
  queryFn: () => api.inbox(),
  refetchInterval: (query) => (query.state.data?.dreamState.running ? 3000 : false),
})

const data = computed(() => inboxQuery.data.value ?? null)
const items = computed(() => data.value?.items ?? [])
const state = computed(() => data.value?.dreamState ?? null)

const triggering = ref(false)
async function triggerDream() {
  if (triggering.value) return
  triggering.value = true
  try {
    const res = await api.runDream()
    if (res.started) {
      toast.add({ title: '已发起整理任务', color: 'success' })
    } else {
      toast.add({ title: res.reason ?? '当前无需重复整理', color: 'neutral' })
    }
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '触发整理失败', color: 'error' })
  } finally {
    triggering.value = false
  }
}

const busyId = ref<string | null>(null)
async function onApply(id: string, body: ApplySuggestionRequest) {
  if (busyId.value) return
  busyId.value = id
  try {
    const res = await api.applySuggestion(id, body)
    toast.add({
      title: res.entry ? `已应用到「${res.entry.title}」` : '已应用整理建议',
      color: 'success',
    })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox'] }),
      queryClient.invalidateQueries({ queryKey: ['entries'] }),
    ])
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '应用失败', color: 'error' })
    if (err instanceof ApiError && err.status === 409) {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    }
  } finally {
    busyId.value = null
  }
}

async function onDismiss(id: string) {
  if (busyId.value) return
  busyId.value = id
  try {
    await api.dismissSuggestion(id)
    toast.add({ title: '已忽略建议', color: 'neutral' })
    void queryClient.invalidateQueries({ queryKey: ['inbox'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <div class="inbox-page">
    <div class="inbox-shell">
      <PageHead title="待处理">
        <template #note>
          整理任务提出的提炼摘要、合并重复、标记过时与更新建议，确认后才会写入记忆。
        </template>
        <template #actions>
          <UButton
            :icon="icons.refresh"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            :loading="inboxQuery.isFetching.value"
            @click="inboxQuery.refetch()"
          />
          <UButton
            :icon="icons.sparkles"
            size="sm"
            :loading="triggering || Boolean(state?.running)"
            :disabled="!me.data.value?.hasChatModel"
            @click="triggerDream"
          >
            {{ state?.running ? '整理中' : '立即整理' }}
          </UButton>
        </template>
      </PageHead>

      <div class="inbox-body">
        <ReadFailureNote v-if="inboxQuery.isError.value" :query="inboxQuery" />

        <NoteLine v-if="me.data.value && !me.data.value.hasChatModel" tone="warning">
          尚未配置对话与整理模型，自动摘要与整理功能未启用。
          <template #actions>
            <UButton size="sm" color="neutral" variant="outline" :to="settingsRoute('models')">
              去配置模型
            </UButton>
          </template>
        </NoteLine>

        <div v-if="state" class="status-strip">
          <span>定时整理：{{ state.enabled ? `每 ${state.intervalHours} 小时` : '已关闭' }}</span>
          <span v-if="state.running" class="text-highlighted font-medium">正在整理…</span>
          <span v-else-if="state.lastRunAt">
            上次整理：
            <time :datetime="state.lastRunAt" :title="formatTime(state.lastRunAt)">
              {{ formatRelative(state.lastRunAt) }}
            </time>
            <template v-if="state.lastOutcome">
              （{{ dreamOutcomeLabels[state.lastOutcome] }}）
            </template>
          </span>
          <span v-else>尚未执行过整理</span>
          <span v-if="state.lastError" class="text-error">错误：{{ state.lastError }}</span>
        </div>

        <div v-if="inboxQuery.isPending.value" class="space-y-4">
          <USkeleton v-for="n in 3" :key="n" class="h-36 w-full" />
        </div>

        <div v-else-if="items.length" class="card-list">
          <DreamSuggestionCard
            v-for="item in items"
            :key="item.id"
            :suggestion="item"
            :busy="busyId === item.id"
            @apply="onApply"
            @dismiss="onDismiss"
          />
        </div>

        <EmptyState
          v-else-if="!inboxQuery.isError.value"
          title="暂无待处理建议"
          description="会话摘要与记忆库变动累积后，定时整理或手动触发会在此生成建议。"
        >
          <template v-if="me.data.value?.hasChatModel" #actions>
            <UButton
              size="sm"
              variant="outline"
              :icon="icons.sparkles"
              :loading="triggering || Boolean(state?.running)"
              @click="triggerDream"
            >
              立即整理
            </UButton>
          </template>
        </EmptyState>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inbox-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.inbox-shell {
  max-width: 56rem;
}
.inbox-body {
  padding: 0 32px 48px;
}
.status-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-bottom: 18px;
  padding: 8px 0;
  border-top: 1px solid var(--ui-rule);
  border-bottom: 1px solid var(--ui-border);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.card-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
@media (max-width: 1023.98px) {
  .inbox-body {
    padding: 0 16px 36px;
  }
}
</style>
