<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { ClientGroupRule } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError, retryable } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { conversationKindLabels, conversationTitle, runCounts } from '../conversations'
import { personMemoryModeLabels, provenanceLabels } from '../labels'
import { entryRoute } from '../routes'
import { formatRelative, formatShort, formatTime } from '../time'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataSwatch from './strata/StrataSwatch.vue'

// 会话详情：会话摘要的时间线、在这里记下的事实、抽取记录，都是新的在前。
// 群聊和频道会话在头部就地展示并允许客户端所有者切换当前人格与单群隔离锁
const props = defineProps<{ circleId: string; id: string }>()
const toast = useToast()
const queryClient = useQueryClient()
const { me, circle } = useSession()

const detail = useQuery({
  queryKey: computed(() => ['conversation', props.circleId, props.id] as const),
  queryFn: ({ queryKey: [, circleId, id] }) => api.conversation(circleId, id),
})
const data = computed(() =>
  detail.data.value && detail.data.value.id === props.id ? detail.data.value : null,
)
const hasGroupRule = computed(
  () =>
    (data.value?.kind === 'group' || data.value?.kind === 'channel') &&
    Boolean(data.value?.subject?.id),
)
const activeClientId = computed(() => (hasGroupRule.value ? (data.value?.client.id ?? null) : null))

const clients = useQuery({
  queryKey: computed(() => ['clients', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.clients(cid),
  enabled: hasGroupRule,
})
const personas = useQuery({
  queryKey: computed(() => ['personas', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.personas(cid),
  enabled: hasGroupRule,
})
const groupRules = useQuery({
  queryKey: computed(() => ['client-group-rules', props.circleId, activeClientId.value] as const),
  queryFn: ({ queryKey: [, cid, clid] }) => api.clientGroupRules(cid, clid!),
  enabled: computed(() => Boolean(activeClientId.value)),
})
const groupPolicyFailedQuery = computed(() => {
  if (groupRules.isError.value) return groupRules
  if (clients.isError.value) return clients
  if (personas.isError.value) return personas
  return null
})

const clientInfo = computed(
  () => clients.data.value?.find((c) => c.id === activeClientId.value) ?? null,
)
const canManageGroupRule = computed(
  () =>
    Boolean(clientInfo.value) &&
    clientInfo.value?.ownerAccountId === me.data.value?.id &&
    circle.value?.role !== 'viewer',
)
const currentGroupRule = computed(() => {
  const sid = data.value?.subject?.id
  if (!sid) return null
  return groupRules.data.value?.rules.find((r) => r.groupSubjectId === sid) ?? null
})
const defaultPersonaLabel = computed(() => {
  const pid = clientInfo.value?.defaultPersonaId
  const found = pid ? personas.data.value?.find((p) => p.id === pid)?.name : null
  return found ? `沿用默认人格（${found}）` : '沿用默认人格（无）'
})
const groupPersonaItems = computed(() => [
  { label: defaultPersonaLabel.value, value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: p.name, value: p.id })),
])
const effectiveGroupPersonaText = computed(() => {
  const overrideId = currentGroupRule.value?.personaId
  if (overrideId) {
    return personas.data.value?.find((p) => p.id === overrideId)?.name ?? '已指定人格'
  }
  return defaultPersonaLabel.value
})
const savingRule = ref(false)
async function patchGroupRule(patch: { personaId?: string | null; isolateGroupMemory?: boolean }) {
  const sid = data.value?.subject?.id
  const clid = activeClientId.value
  if (!sid || !clid || savingRule.value) return
  const existing = (groupRules.data.value?.rules ?? []).map(
    ({ groupSubjectId, personaId, isolateGroupMemory }): ClientGroupRule => ({
      groupSubjectId,
      personaId,
      isolateGroupMemory,
    }),
  )
  const prev = existing.find((r) => r.groupSubjectId === sid)
  const nextPersona = patch.personaId !== undefined ? patch.personaId : (prev?.personaId ?? null)
  const nextIsolate =
    patch.isolateGroupMemory !== undefined
      ? patch.isolateGroupMemory
      : (prev?.isolateGroupMemory ?? false)
  const rest = existing.filter((r) => r.groupSubjectId !== sid)
  const nextRules =
    nextPersona !== null || nextIsolate
      ? [...rest, { groupSubjectId: sid, personaId: nextPersona, isolateGroupMemory: nextIsolate }]
      : rest
  const key = ['client-group-rules', props.circleId, clid] as const
  savingRule.value = true
  try {
    const saved = await api.saveClientGroupRules(props.circleId, clid, { rules: nextRules })
    queryClient.setQueryData(key, saved)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['personas', props.circleId] }),
      queryClient.invalidateQueries({ queryKey: ['persona', props.circleId] }),
      queryClient.invalidateQueries({ queryKey: ['clients', props.circleId] }),
    ])
    toast.add({ title: '已更新本群规则', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    savingRule.value = false
  }
}

// 窄屏上打开一个会话之后，页面把焦点放到这里
const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <article class="conversation-detail">
    <div v-if="detail.isPending.value" class="detail-note space-y-3">
      <slot name="nav" />
      <USkeleton class="h-7 w-1/3" />
      <USkeleton class="h-40 w-full" />
    </div>
    <!-- 没读到过，或者是确定的结果（别处删掉、失效后的 404）：整块报错，旧内容不留 -->
    <div
      v-else-if="!data || (detail.isError.value && !retryable(detail.error.value))"
      class="detail-note"
    >
      <slot name="nav" />
      <ReadFailureNote :query="detail" />
    </div>
    <template v-else>
      <StrataStrip band="episode" :sensitivity="data.kind === 'none' ? 'private' : 'public'" />
      <header class="detail-head">
        <slot name="nav" />
        <h2 ref="titleEl" tabindex="-1">{{ conversationTitle(data) }}</h2>
        <p class="head-meta">
          <RouterLink
            :to="{ name: 'client', params: { circleId, clientId: data.client.id } }"
            class="head-link"
          >
            {{ data.client.name }}
          </RouterLink>
          <span>{{
            data.kind === 'none' ? '本人（本机无上下文）' : conversationKindLabels[data.kind]
          }}</span>
          <span v-if="data.projectSlug" class="font-mono">项目 {{ data.projectSlug }}</span>
          <span v-if="data.deviceKey" class="font-mono">设备 {{ data.deviceKey }}</span>
          <RouterLink
            v-if="data.subject"
            :to="{ name: 'contact', params: { circleId, subjectId: data.subject.id } }"
            class="head-link"
          >
            {{ data.subject.kind === 'group' ? '群的联系人详情' : '联系人详情' }}
          </RouterLink>
          <span>
            最近活动
            <time :datetime="data.lastActiveAt" :title="formatTime(data.lastActiveAt)">
              {{ formatRelative(data.lastActiveAt) }}
            </time>
          </span>
        </p>

        <div v-if="hasGroupRule && groupPolicyFailedQuery" class="mt-2.5">
          <ReadFailureNote :query="groupPolicyFailedQuery" />
        </div>
        <div v-else-if="hasGroupRule && groupRules.data.value" class="group-policy-bar">
          <RouterLink
            v-if="clientInfo"
            :to="{ name: 'client', params: { circleId, clientId: clientInfo.id } }"
            class="policy-mode head-link"
          >
            客户端模式：{{ personMemoryModeLabels[clientInfo.config.personMemoryMode ?? 'strict'] }}
          </RouterLink>
          <template v-if="canManageGroupRule">
            <label class="policy-field">
              <span>{{ data.kind === 'channel' ? '本频道人格' : '本群人格' }}</span>
              <USelect
                :model-value="currentGroupRule?.personaId ?? null"
                :items="groupPersonaItems"
                value-key="value"
                size="xs"
                class="w-48"
                aria-label="按群人格"
                :disabled="savingRule"
                @update:model-value="
                  (v) => patchGroupRule({ personaId: (v as string | null) ?? null })
                "
              />
            </label>
            <span class="policy-field">
              <USwitch
                size="xs"
                label="单群隔离锁"
                :model-value="Boolean(currentGroupRule?.isolateGroupMemory)"
                :disabled="savingRule"
                @update:model-value="(v) => patchGroupRule({ isolateGroupMemory: Boolean(v) })"
              />
              <Hint>
                开启后，本群产生的人物事实不向其他群流出，其他群产生的人物印象也不带入本群。
              </Hint>
            </span>
          </template>
          <template v-else>
            <span class="policy-readonly">
              {{ data.kind === 'channel' ? '本频道人格' : '本群人格' }}：{{
                effectiveGroupPersonaText
              }}
            </span>
            <span class="policy-readonly">
              单群隔离锁：{{ currentGroupRule?.isolateGroupMemory ? '已开启' : '未开启' }}
            </span>
          </template>
        </div>
      </header>

      <div v-if="detail.isError.value" class="stale-note">
        <ReadFailureNote :query="detail" />
      </div>

      <div class="detail-body">
        <section>
          <SectionHeading :title="`会话摘要（${data.summaries.length}）`">
            <template #hint>
              <Hint>
                {{
                  data.kind === 'none'
                    ? '不带会话上下文的会话只写摘要，不记联系人的事实。'
                    : '群聊、频道与私聊的摘要来自未确认来源，不进入启动加载。'
                }}会话摘要到期后清除。
              </Hint>
            </template>
            <template #actions>
              <StrataSwatch band="episode" plain label="band" />
            </template>
          </SectionHeading>
          <p v-if="!data.summaries.length" class="empty">暂无会话摘要</p>
          <ol v-else class="timeline">
            <li v-for="summary in data.summaries" :key="summary.id" class="entry-row">
              <time
                class="entry-time"
                :datetime="summary.createdAt"
                :title="formatTime(summary.createdAt)"
              >
                {{ formatShort(summary.createdAt) }}
              </time>
              <div class="entry-body">
                <p class="entry-text">{{ summary.content }}</p>
                <p class="entry-meta">
                  <RouterLink
                    v-if="summary.shortId"
                    :to="entryRoute(circleId, summary.shortId)"
                    class="short-id entry-link"
                  >
                    {{ summary.shortId }}
                  </RouterLink>
                  <span>{{ provenanceLabels[summary.provenance] }}</span>
                  <span v-if="summary.expiresAt">{{ formatTime(summary.expiresAt) }} 到期</span>
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section v-if="data.kind !== 'none'">
          <SectionHeading :title="`在这里记下的事实（${data.facts.length}）`">
            <template #hint>
              <Hint>事实挂在各自的联系人上，在联系人详情中提炼、删除或恢复生效。</Hint>
            </template>
            <template #actions>
              <StrataSwatch band="fact" plain label="band" />
            </template>
          </SectionHeading>
          <p v-if="!data.facts.length" class="empty">暂无事实</p>
          <ul v-else>
            <li v-for="fact in data.facts" :key="fact.id" class="entry-row">
              <div class="entry-body">
                <p class="entry-text">{{ fact.content }}</p>
                <p class="entry-meta">
                  <RouterLink
                    v-if="fact.shortId"
                    :to="entryRoute(circleId, fact.shortId)"
                    class="short-id entry-link"
                  >
                    {{ fact.shortId }}
                  </RouterLink>
                  <RouterLink
                    :to="{ name: 'contact', params: { circleId, subjectId: fact.subject.id } }"
                    class="entry-link"
                  >
                    {{ fact.subject.displayName }}
                  </RouterLink>
                  <span>{{ provenanceLabels[fact.provenance] }}</span>
                  <time :datetime="fact.updatedAt" :title="formatTime(fact.updatedAt)">
                    {{ formatRelative(fact.updatedAt) }}
                  </time>
                </p>
              </div>
            </li>
          </ul>
        </section>

        <section>
          <SectionHeading title="最近抽取" />
          <p v-if="!data.runs.length" class="empty">暂无相关抽取</p>
          <ul v-else>
            <li v-for="run in data.runs" :key="run.id" class="entry-row">
              <div class="entry-body">
                <p class="entry-meta">
                  <time :datetime="run.createdAt" :title="formatTime(run.createdAt)">
                    {{ formatShort(run.createdAt) }}
                  </time>
                  <span v-if="run.client">{{ run.client.name }}</span>
                  <span v-if="run.summaryOnly" class="text-warning">预算已用完，仅写入摘要</span>
                  <span v-else-if="run.summarized">已写入摘要</span>
                </p>
                <p class="entry-meta">{{ runCounts(run) }}</p>
                <p v-if="run.error" class="entry-meta text-error">{{ run.error }}</p>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </article>
</template>

<style scoped>
.conversation-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.conversation-detail > * {
  flex: none;
}
.detail-note {
  padding: 24px 32px;
}
.stale-note {
  padding: 14px 32px 0;
}
.detail-head {
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-head h2 {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-head h2:focus {
  outline: 0;
}
.head-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
  margin-top: 4px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.head-link,
.entry-link {
  color: var(--ui-text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.head-link:hover,
.entry-link:hover {
  text-decoration-color: currentColor;
}
.detail-body {
  padding: 20px 32px 48px;
}
.detail-body section + section {
  margin-top: 26px;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.entry-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--ui-border);
}
.entry-time {
  flex: none;
  width: 6.5rem;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.65rem;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.entry-body {
  flex: 1;
  min-width: 0;
}
.entry-text {
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.entry-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 10px;
  line-height: 1.6;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.short-id {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-toned);
}
.group-policy-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--ui-border);
  font-size: 13px;
}
.policy-mode,
.policy-readonly {
  color: var(--ui-text-muted);
}
.policy-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
@media (max-width: 1023.98px) {
  .detail-note {
    padding: 16px;
  }
  .stale-note {
    padding: 12px 16px 0;
  }
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-body {
    padding: 16px 16px 32px;
  }
  .entry-row {
    flex-direction: column;
    gap: 2px;
  }
  .entry-time {
    width: auto;
    line-height: 1.6;
  }
}
</style>
