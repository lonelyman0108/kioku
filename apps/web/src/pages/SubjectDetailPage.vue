<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ExtractionRunInfo, OriginScope, UpdateSubjectRequest } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { provenanceLabels } from '../labels'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const subjectId = computed(() => String(route.params.subjectId))
const role = computed(() => space.value?.role ?? 'viewer')
const canEdit = computed(() => role.value === 'owner' || role.value === 'editor')

const subject = useQuery({
  queryKey: computed(() => ['subject', spaceId.value, subjectId.value]),
  queryFn: () => api.subject(spaceId.value, subjectId.value),
})
const data = computed(() => subject.data.value ?? null)
const linkedToMe = computed(() => data.value?.account?.id === me.data.value?.id)

const name = ref('')
watch(
  () => data.value?.displayName,
  (value) => (name.value = value ?? ''),
  { immediate: true },
)

const saving = ref(false)
async function update(body: UpdateSubjectRequest, done: string) {
  const sid = spaceId.value
  const id = subjectId.value
  saving.value = true
  try {
    await api.updateSubject(sid, id, body)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['subject', sid, id] }),
      queryClient.invalidateQueries({ queryKey: ['subjects', sid] }),
    ])
    toast.add({ title: done, color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

function scopeLabel(scope: OriginScope): string {
  switch (scope.kind) {
    case 'group':
      return scope.name ? `群「${scope.name}」` : '已删除的群'
    case 'direct':
      return scope.name ? `和「${scope.name}」的私聊` : '已删除的私聊对象'
    case 'app':
      return scope.name ? `应用「${scope.name}」` : '已删除的应用'
    default:
      return '全局'
  }
}

// 一批抽取的结果：只列不为零的几项
function runCounts(run: ExtractionRunInfo): string {
  const parts = [`${run.turns} 轮`]
  if (run.added) parts.push(`新增 ${run.added}`)
  if (run.updated) parts.push(`更新 ${run.updated}`)
  if (run.unchanged) parts.push(`已有 ${run.unchanged}`)
  if (run.dropped) parts.push(`丢掉 ${run.dropped}`)
  if (run.limited) parts.push(`超出每天的条数 ${run.limited}`)
  if (run.skippedTurns) parts.push(`${run.skippedTurns} 轮的 Key 已失效`)
  return parts.join(' · ')
}
</script>

<template>
  <UDashboardPanel id="subject">
    <template #header>
      <UDashboardNavbar :title="data?.displayName ?? '对象'">
        <template #leading>
          <UButton
            :icon="icons.back"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="返回对象列表"
            :to="{ name: 'subjects', params: { spaceId } }"
          />
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <USkeleton v-if="subject.isPending.value" class="h-40 w-full" />
      <UAlert
        v-else-if="subject.isError.value || !data"
        color="error"
        variant="subtle"
        :title="subject.error.value instanceof ApiError ? subject.error.value.message : '读取失败'"
      />
      <div v-else class="max-w-3xl space-y-6">
        <UCard>
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon :name="data.kind === 'group' ? icons.group : icons.user" class="size-4" />
              <h2 class="text-sm font-medium">{{ data.kind === 'group' ? '群' : '人' }}</h2>
              <span class="ml-auto text-xs text-muted"
                >第一次遇到：{{ formatTime(data.createdAt) }}</span
              >
            </div>
          </template>
          <div class="space-y-4">
            <UFormField label="名字" help="改过之后，平台上的显示名再变也不跟着改">
              <div class="flex gap-2">
                <UInput
                  v-model="name"
                  name="displayName"
                  class="w-full"
                  :disabled="!canEdit"
                  maxlength="128"
                />
                <UButton
                  v-if="canEdit"
                  variant="subtle"
                  class="shrink-0"
                  :loading="saving"
                  :disabled="!name.trim() || name.trim() === data.displayName"
                  @click="update({ displayName: name.trim() }, '已改名')"
                  >保存</UButton
                >
              </div>
            </UFormField>

            <div v-if="data.kind === 'person'" class="space-y-1 text-sm">
              <p class="font-medium">这是我</p>
              <div class="flex flex-wrap items-center gap-2">
                <template v-if="!data.account">
                  <span class="text-muted">还没标记为任何成员。</span>
                  <UButton
                    v-if="canEdit"
                    size="sm"
                    variant="subtle"
                    :loading="saving"
                    @click="update({ linkedToMe: true }, '已标记为你')"
                    >这是我</UButton
                  >
                </template>
                <template v-else-if="linkedToMe">
                  <UBadge color="primary" variant="subtle">这是你</UBadge>
                  <UButton
                    v-if="canEdit"
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    :loading="saving"
                    @click="update({ linkedToMe: false }, '已取消标记')"
                    >取消</UButton
                  >
                </template>
                <template v-else>
                  <span>已标记为「{{ data.account.displayName }}」</span>
                  <UButton
                    v-if="role === 'owner'"
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    :loading="saving"
                    @click="update({ linkedToMe: false }, '已取消标记')"
                    >取消标记</UButton
                  >
                </template>
              </div>
              <p class="text-xs text-muted">
                标记为你之后，你的应用把这个人的私聊当作主人私聊（应用开了「主人私聊提升」时能读到你的画像）。只能标记成自己。
              </p>
            </div>

            <div class="space-y-1 text-sm">
              <p class="font-medium">平台账号</p>
              <ul class="space-y-1">
                <li
                  v-for="identity in data.identities"
                  :key="`${identity.platform}:${identity.externalId}`"
                  class="flex flex-wrap gap-2"
                >
                  <UBadge color="neutral" variant="subtle" size="sm">{{
                    identity.platform
                  }}</UBadge>
                  <code class="text-xs">{{ identity.externalId }}</code>
                  <span v-if="identity.displayName" class="text-muted">{{
                    identity.displayName
                  }}</span>
                </li>
              </ul>
            </div>
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="text-sm font-medium">记下的事实（{{ data.facts.length }}）</h2>
          </template>
          <p v-if="!data.facts.length" class="text-sm text-muted">还没有记下关于它的事。</p>
          <ul v-else class="divide-y divide-default">
            <li v-for="fact in data.facts" :key="fact.id" class="space-y-1 py-2">
              <p class="text-sm whitespace-pre-wrap">{{ fact.content }}</p>
              <p class="flex flex-wrap gap-2 text-xs text-muted">
                <span>{{ scopeLabel(fact.scope) }}</span>
                <span>{{ provenanceLabels[fact.provenance] }}</span>
                <span>{{ formatRelative(fact.updatedAt) }}</span>
              </p>
            </li>
          </ul>
        </UCard>

        <UCard v-if="data.summaries.length">
          <template #header>
            <h2 class="text-sm font-medium">
              {{ data.kind === 'group' ? '群里的会话摘要' : '私聊的会话摘要' }}
            </h2>
          </template>
          <ul class="divide-y divide-default">
            <li v-for="summary in data.summaries" :key="summary.id" class="space-y-1 py-2">
              <p class="text-sm whitespace-pre-wrap">{{ summary.content }}</p>
              <p class="text-xs text-muted">
                {{ formatRelative(summary.createdAt) }}
                <template v-if="summary.expiresAt">
                  · {{ formatTime(summary.expiresAt) }} 到期</template
                >
              </p>
            </li>
          </ul>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="text-sm font-medium">最近的抽取</h2>
          </template>
          <p v-if="!data.runs.length" class="text-sm text-muted">还没有涉及它的抽取。</p>
          <ul v-else class="divide-y divide-default">
            <li v-for="run in data.runs" :key="run.id" class="space-y-1 py-2 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <span>{{ formatTime(run.createdAt) }}</span>
                <span class="text-muted">{{ run.app?.name ?? '已删除的应用' }}</span>
                <span class="text-muted">{{ scopeLabel(run.scope) }}</span>
                <UBadge v-if="run.summaryOnly" color="warning" variant="subtle" size="sm"
                  >预算用完，只写了摘要</UBadge
                >
                <UBadge v-else-if="run.summarized" color="neutral" variant="subtle" size="sm"
                  >写了摘要</UBadge
                >
              </div>
              <p class="text-xs text-muted">{{ runCounts(run) }}</p>
              <p v-if="run.error" class="text-xs text-error">{{ run.error }}</p>
            </li>
          </ul>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
