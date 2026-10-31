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
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'

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
  <div class="space-y-6">
    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <code class="rounded bg-elevated px-1.5 py-0.5 text-sm">{{ c.identifier }}</code>
        <UBadge variant="subtle">{{ credentialSourceLabels[c.source] }}</UBadge>
        <UBadge v-if="c.deletedAt" color="error" variant="subtle">已删除</UBadge>
      </div>
      <p v-if="c.description" class="text-sm whitespace-pre-wrap">{{ c.description }}</p>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <UButton
          :icon="icons.copy"
          size="xs"
          color="neutral"
          variant="subtle"
          @click="copy(placeholder())"
        >
          复制凭据占位符
        </UButton>
        <template v-if="canManage">
          <UButton
            v-if="!c.deletedAt"
            :icon="icons.edit"
            size="xs"
            variant="subtle"
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
              :icon="icons.remove"
              size="xs"
              color="error"
              variant="subtle"
              :disabled="c.referenceCount > 0"
              @click="emit('remove')"
            >
              删除
            </UButton>
          </UTooltip>
          <UButton
            v-else
            :icon="icons.undelete"
            size="xs"
            variant="subtle"
            @click="emit('undelete')"
          >
            恢复
          </UButton>
        </template>
      </div>
    </div>

    <section class="space-y-2">
      <h3 class="text-sm font-medium">来源</h3>
      <dl v-if="c.source === 'external'" class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt class="text-muted">凭据源</dt>
        <dd>
          <template v-if="c.provider">
            {{ c.provider.name }}（{{ providerKindLabels[c.provider.kind] }}）
            <UBadge v-if="c.provider.deleted" color="warning" variant="subtle" size="sm">
              已删除，需重新绑定
            </UBadge>
          </template>
        </dd>
        <dt class="text-muted">条目位置</dt>
        <dd class="break-all">{{ c.location }}</dd>
      </dl>
      <p v-else class="text-sm text-muted">
        值由 Kioku 使用主密钥加密保存，仅在显式查看或 Agent 显式取用时解密。
      </p>
    </section>

    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-medium">字段</h3>
        <UButton
          v-if="c.source === 'hosted' && canManage && !c.deletedAt && !revealed"
          :icon="icons.reveal"
          size="xs"
          color="neutral"
          variant="ghost"
          class="ml-auto"
          @click="confirmingReveal = true"
        >
          查看值
        </UButton>
        <UButton
          v-else-if="revealed"
          :icon="icons.left"
          size="xs"
          color="neutral"
          variant="ghost"
          class="ml-auto"
          @click="revealed = null"
        >
          隐藏
        </UButton>
      </div>
      <ul class="divide-y divide-default rounded-lg border border-default text-sm">
        <li v-for="field in c.fields" :key="field.name" class="flex items-center gap-2 px-3 py-2">
          <code class="text-xs">{{ field.name }}</code>
          <span v-if="field.sourceField" class="text-xs text-muted">
            → 条目字段 {{ field.sourceField }}
          </span>
          <template v-if="c.source === 'hosted'">
            <code
              v-if="revealed && field.name in revealed"
              class="min-w-0 flex-1 break-all rounded bg-elevated px-1.5 py-0.5 text-xs"
              >{{ revealed[field.name] }}</code
            >
            <span v-else class="flex-1 text-muted">••••••</span>
            <UButton
              v-if="revealed && field.name in revealed"
              :icon="icons.copy"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="`复制 ${field.name} 的值`"
              @click="copy(revealed[field.name]!)"
            />
          </template>
          <span v-else class="flex-1" />
          <UButton
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

    <section class="space-y-1">
      <h3 class="text-sm font-medium">限定应用</h3>
      <p class="text-sm">{{ appNames }}</p>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-medium">引用此凭据的记忆</h3>
      <p class="text-xs text-muted">
        仍有引用时无法删除凭据。
        <Hint>仅统计当前账号私人层中未删除、非机密、仍有效的记忆。</Hint>
      </p>
      <USkeleton v-if="references.isPending.value" class="h-8 w-full" />
      <ul v-else-if="references.data.value?.items.length" class="space-y-1 text-sm">
        <li v-for="m in references.data.value.items" :key="m.id" class="flex items-center gap-2">
          <ULink
            :to="{ name: 'memories', params: { spaceId }, query: { uri: m.uri } }"
            class="font-mono text-xs"
          >
            {{ m.uri }}
          </ULink>
          <span class="text-xs text-muted">{{ sensitivityLabels[m.sensitivity] }}</span>
          <time
            :datetime="m.updatedAt"
            :title="formatTime(m.updatedAt)"
            class="ml-auto text-xs text-muted"
          >
            {{ formatRelative(m.updatedAt) }}
          </time>
        </li>
        <li v-if="references.data.value.truncated" class="text-xs text-muted">仅显示最近 200 条</li>
      </ul>
      <p v-else class="text-sm text-muted">暂无引用</p>
    </section>

    <section class="space-y-2">
      <h3 class="text-sm font-medium">记录</h3>
      <p class="text-xs text-muted">
        记录新建、修改、删除与每次取用。
        <Hint>仅凭据所有者可见，不进入空间的变更记录。</Hint>
      </p>
      <USkeleton v-if="events.isPending.value" class="h-8 w-full" />
      <ol v-else class="space-y-2 text-sm">
        <li v-for="e in eventItems" :key="e.id" class="rounded-lg border border-default px-3 py-2">
          <div class="flex flex-wrap items-center gap-2">
            <UIcon
              :name="(credentialEventLabels[e.type] ?? credentialEventLabels.update)!.icon"
              class="size-4 text-muted"
            />
            <span class="font-medium">{{ credentialEventLabels[e.type]?.label ?? e.type }}</span>
            <span class="text-muted">{{ actorLabel(e.actor).name }}</span>
            <template v-if="e.bench">
              <UBadge size="sm" color="info" variant="subtle" :title="`运行标记 ${e.bench.run}`">
                测试台
              </UBadge>
              <span class="text-xs text-muted">操作账号：{{ benchAccountLabel(e.bench) }}</span>
            </template>
            <time
              :datetime="e.createdAt"
              :title="formatTime(e.createdAt)"
              class="ml-auto text-xs text-muted"
            >
              {{ formatRelative(e.createdAt) }}
            </time>
          </div>
          <p v-if="describe(e)" class="mt-1 text-xs text-muted">{{ describe(e) }}</p>
        </li>
      </ol>
      <UButton
        v-if="events.hasNextPage.value"
        size="xs"
        color="neutral"
        variant="subtle"
        :loading="events.isFetchingNextPage.value"
        @click="events.fetchNextPage()"
      >
        加载更早的记录
      </UButton>
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
