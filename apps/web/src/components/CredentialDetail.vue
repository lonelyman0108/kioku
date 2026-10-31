<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { AppInfo, ConsoleCredential, CredentialEvent } from '@kioku/contracts'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import {
  actorLabel,
  benchAccountLabel,
  credentialChangeLabels,
  credentialEventLabels,
  credentialSourceLabels,
  credentialViaLabels,
  providerKindLabels,
  restrictedAppsLabel,
  sensitivityLabels,
} from '../labels'
import { memoryRoute } from '../routes'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import MemoryRow from './strata/MemoryRow.vue'
import PropertyList from './strata/PropertyList.vue'
import SectionHeading from './strata/SectionHeading.vue'

const props = defineProps<{
  spaceId: string
  credential: ConsoleCredential
  // 还没读出来时为 undefined
  apps: AppInfo[] | undefined
  canManage: boolean
}>()
const emit = defineEmits<{ edit: []; remove: []; undelete: [] }>()
const toast = useToast()

const c = computed(() => props.credential)
const placeholder = (field?: string) => `{{cred:${c.value.identifier}${field ? `#${field}` : ''}}}`
const { me } = useSession()
const appNames = computed(() => restrictedAppsLabel(c.value.appIds, props.apps, me.data.value?.id))

const copy = useCopy()

const references = useQuery({
  queryKey: computed(() => ['credential-references', props.spaceId, c.value.id] as const),
  queryFn: ({ queryKey: [, spaceId, id] }) => api.credentialReferences(spaceId, id),
})
const events = useInfiniteQuery({
  queryKey: computed(() => ['credential-events', props.spaceId, c.value.id] as const),
  queryFn: ({ pageParam, queryKey: [, spaceId, id] }) =>
    api.credentialEvents(spaceId, id, pageParam),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last) => last.nextCursor ?? undefined,
})
const eventItems = computed(() => events.data.value?.pages.flatMap((p) => p.items) ?? [])

// 事件的细节：取用经由哪里、改了哪些部分、涉及哪些字段
function describe(e: CredentialEvent): string {
  const parts: string[] = []
  if (e.via) parts.push(credentialViaLabels[e.via] ?? e.via)
  if (e.changes.length) {
    parts.push(`修改了${e.changes.map((x) => credentialChangeLabels[x] ?? x).join('、')}`)
  }
  if (e.fields.length) parts.push(`字段 ${e.fields.join('、')}`)
  return parts.join('；')
}

// 查看托管的值：要先确认，每次查看都记一条访问事件。值只放在这个组件里，不进查询缓存，换了凭据或关掉就清掉
const revealed = ref<Record<string, string> | null>(null)
const confirmingReveal = ref(false)
const revealing = ref(false)
// 换了凭据、或这条被改过（版本变了）：之前查看的值可能已经不对，清掉；记录重新拉一次
watch(
  () => [c.value.id, c.value.version] as const,
  ([id], [oldId]) => {
    revealed.value = null
    if (id === oldId) void events.refetch()
  },
)
onBeforeUnmount(() => (revealed.value = null))
async function reveal() {
  const { id, version } = c.value
  revealing.value = true
  try {
    const { values } = await api.revealCredential(props.spaceId, id)
    confirmingReveal.value = false
    // 请求期间换成了别的凭据、或这条被改过：值可能已经不对，不显示
    if (c.value.id === id && c.value.version === version) revealed.value = values
    void events.refetch()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '查看失败', color: 'error' })
  } finally {
    revealing.value = false
  }
}
</script>

<template>
  <div class="credential-detail">
    <header class="detail-head">
      <p class="detail-identifier">{{ c.identifier }}</p>
      <p class="detail-source">
        {{ credentialSourceLabels[c.source] }}
        <span v-if="c.deletedAt" class="text-error">已删除</span>
      </p>
      <p v-if="c.description" class="detail-description">{{ c.description }}</p>
      <div class="detail-actions">
        <UButton size="sm" color="primary" variant="outline" @click="copy(placeholder())">
          复制凭据占位符
        </UButton>
        <template v-if="canManage">
          <UButton
            v-if="!c.deletedAt"
            size="sm"
            color="primary"
            variant="outline"
            @click="emit('edit')"
          >
            修改
          </UButton>
          <UTooltip
            v-if="!c.deletedAt"
            :text="
              c.referenceCount
                ? `无法删除：仍有 ${c.referenceCount} 条记忆引用。请先修改这些引用。`
                : undefined
            "
            :disabled="!c.referenceCount"
          >
            <UButton
              size="sm"
              color="error"
              variant="outline"
              :disabled="c.referenceCount > 0"
              @click="emit('remove')"
            >
              删除
            </UButton>
          </UTooltip>
          <UButton v-else size="sm" color="primary" variant="outline" @click="emit('undelete')">
            恢复
          </UButton>
        </template>
      </div>
    </header>

    <section>
      <SectionHeading title="来源" :level="3" />
      <PropertyList
        v-if="c.source === 'external'"
        class="pt-2"
        :groups="[
          [
            { key: 'provider', label: '凭据源' },
            { key: 'location', label: '条目位置' },
          ],
        ]"
      >
        <template #provider>
          <template v-if="c.provider">
            {{ c.provider.name }}（{{ providerKindLabels[c.provider.kind] }}）
            <span v-if="c.provider.deleted" class="text-warning">已删除，需重新绑定</span>
          </template>
        </template>
        <template #location>
          <span class="font-mono text-[13px]">{{ c.location }}</span>
        </template>
      </PropertyList>
      <p v-else class="section-note">
        值由 Kioku 使用主密钥加密保存，仅在显式查看或 Agent 显式取用时解密。
      </p>
    </section>

    <section>
      <SectionHeading title="字段" :level="3">
        <template #actions>
          <UButton
            v-if="c.source === 'hosted' && canManage && !c.deletedAt && !revealed"
            size="xs"
            color="primary"
            variant="outline"
            @click="confirmingReveal = true"
          >
            查看值
          </UButton>
          <UButton
            v-else-if="revealed"
            size="xs"
            color="primary"
            variant="outline"
            @click="revealed = null"
          >
            隐藏
          </UButton>
        </template>
      </SectionHeading>
      <ul>
        <li v-for="field in c.fields" :key="field.name" class="field-row">
          <span class="field-name">{{ field.name }}</span>
          <template v-if="c.source === 'hosted'">
            <span v-if="revealed && field.name in revealed" class="field-value">
              <code>{{ revealed[field.name] }}</code>
              <UButton
                :icon="icons.copy"
                size="xs"
                color="neutral"
                variant="ghost"
                :aria-label="`复制 ${field.name} 的值`"
                @click="copy(revealed[field.name]!)"
              />
            </span>
            <span v-else class="field-value">
              <span class="value-mask" role="img" aria-label="值已隐藏">••••••</span>
            </span>
          </template>
          <span v-else class="field-value field-source">
            <template v-if="field.sourceField">→ 条目字段 {{ field.sourceField }}</template>
          </span>
          <UButton
            class="shrink-0"
            size="xs"
            color="neutral"
            variant="ghost"
            :aria-label="`复制 ${field.name} 的占位符`"
            @click="copy(placeholder(field.name))"
          >
            复制占位符
          </UButton>
        </li>
      </ul>
    </section>

    <section>
      <SectionHeading title="限定应用" :level="3" />
      <p class="section-text">{{ appNames }}</p>
    </section>

    <section>
      <SectionHeading title="引用此凭据的记忆" :level="3">
        <template #hint>
          <Hint>仅统计当前账号私人层中未删除、非机密、仍有效的记忆。</Hint>
        </template>
      </SectionHeading>
      <p class="section-note">仍有引用时无法删除凭据。</p>
      <USkeleton v-if="references.isPending.value" class="h-8 w-full" />
      <ul v-else-if="references.data.value?.items.length">
        <li v-for="m in references.data.value.items" :key="m.id">
          <MemoryRow
            flush
            :uri="m.uri"
            layer="private"
            :sensitivity="m.sensitivity"
            :to="memoryRoute(spaceId, m.uri)"
          >
            <template #flags>
              <span class="reference-flags">
                <span>{{ sensitivityLabels[m.sensitivity] }}</span>
                <time :datetime="m.updatedAt" :title="formatTime(m.updatedAt)">
                  {{ formatRelative(m.updatedAt) }}
                </time>
              </span>
            </template>
          </MemoryRow>
        </li>
        <li v-if="references.data.value.truncated" class="section-note">仅显示最近 200 条</li>
      </ul>
      <p v-else class="section-empty">暂无引用</p>
    </section>

    <section>
      <SectionHeading title="记录" :level="3">
        <template #hint>
          <Hint>仅凭据所有者可见，不进入空间的变更记录。</Hint>
        </template>
      </SectionHeading>
      <p class="section-note">记录新建、修改、删除与每次取用。</p>
      <USkeleton v-if="events.isPending.value" class="h-8 w-full" />
      <ol v-else>
        <li v-for="e in eventItems" :key="e.id" class="event-row">
          <span class="event-type">{{ credentialEventLabels[e.type]?.label ?? e.type }}</span>
          <span class="event-actor">{{ actorLabel(e.actor).name }}</span>
          <time class="event-time" :datetime="e.createdAt" :title="formatTime(e.createdAt)">
            {{ formatRelative(e.createdAt) }}
          </time>
          <p v-if="describe(e) || e.bench" class="event-detail">
            <span v-if="describe(e)">{{ describe(e) }}</span>
            <template v-if="e.bench">
              <span class="bench-flag" :title="`运行标记 ${e.bench.run}`">测试台</span>
              <span>操作账号：{{ benchAccountLabel(e.bench) }}</span>
            </template>
          </p>
        </li>
      </ol>
      <div v-if="events.hasNextPage.value" class="pt-3">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :loading="events.isFetchingNextPage.value"
          @click="events.fetchNextPage()"
        >
          加载更早的记录
        </UButton>
      </div>
    </section>

    <UModal v-model:open="confirmingReveal" title="查看托管的值？">
      <template #body>
        <p class="text-sm">值将显示在此页面上，并记录一次访问。查看后请点击「隐藏」或关闭面板。</p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingReveal = false">取消</UButton>
          <UButton :loading="revealing" @click="reveal">查看</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.credential-detail section {
  margin-top: 22px;
}
.detail-identifier {
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-source {
  display: flex;
  gap: 10px;
  margin-top: 1px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.detail-description {
  margin-top: 6px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 11px;
}
.section-note {
  padding-top: 8px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.section-text {
  padding-top: 8px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.section-empty {
  padding-top: 8px;
  color: var(--ui-text-muted);
}
.field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
  padding: 4px 0;
  border-bottom: 1px solid var(--ui-border);
}
.field-name {
  flex: none;
  width: 7.5rem;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field-value {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.field-value code {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.field-source {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.value-mask {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.reference-flags {
  display: inline-flex;
  gap: 10px;
  font-size: 13px;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
/* 压在整行的点击区上面，悬停才看得到完整时间 */
.reference-flags time {
  position: relative;
  z-index: 1;
}
.event-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  column-gap: 8px;
  align-items: baseline;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
  line-height: 1.5;
}
.event-type {
  font-weight: 500;
}
.event-actor {
  min-width: 0;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.event-time {
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.event-detail {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.bench-flag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
}
</style>
