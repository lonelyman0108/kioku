<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type {
  ExtractionRunInfo,
  SubjectFact,
  SupersededFact,
  UpdateSubjectRequest,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import SubjectBindings from '../components/SubjectBindings.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { originScopeText, provenanceLabels } from '../labels'
import { refreshSubjectCaches as refreshCaches } from '../subjectQueries'
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

// 换了对象就重新填；同一个对象只在输入框没被改动时跟着服务端的名字走，刷新时不冲掉正在输入的内容
const name = ref('')
let synced = ''
watch(
  [subjectId, () => data.value?.displayName],
  ([id, value], [previousId]) => {
    if (id !== previousId || name.value === synced) name.value = value ?? ''
    synced = value ?? ''
  },
  { immediate: true },
)

const refreshSubjectCaches = (sid: string) => refreshCaches(queryClient, sid)
// 等你确认的绑定：卡片标题上提醒
const waitingForMe = computed(
  () => data.value?.bindings.filter((b) => b.canConfirm || b.canReject).length ?? 0,
)

const saving = ref(false)
async function update(body: UpdateSubjectRequest, done: string) {
  const sid = spaceId.value
  const id = subjectId.value
  saving.value = true
  try {
    const saved = await api.updateSubject(sid, id, body)
    // 服务端会去掉首尾空白：输入框换成保存下来的名字，之后才能接着跟服务端同步
    if (body.displayName !== undefined && id === subjectId.value) {
      name.value = saved.displayName
      synced = saved.displayName
    }
    await refreshSubjectCaches(sid)
    toast.add({ title: done, color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

// 删一条事实：确认框打开时记下这一版，期间被改过服务端会返回冲突
const deletingFact = ref<SubjectFact | null>(null)
const removing = ref(false)
async function removeFact() {
  const fact = deletingFact.value
  if (!fact) return
  const sid = spaceId.value
  removing.value = true
  try {
    await api.deleteFact(sid, subjectId.value, fact.id, fact.version)
    toast.add({ title: '已删除事实', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
  } finally {
    removing.value = false
    deletingFact.value = null
    void refreshSubjectCaches(sid)
  }
}

// 让一条被推翻的事实重新生效，带上看到的版本：期间被改过服务端会返回冲突
const reactivating = ref<string | null>(null)
async function reactivateFact(fact: SupersededFact) {
  if (reactivating.value) return
  const sid = spaceId.value
  reactivating.value = fact.id
  try {
    await api.reactivateFact(sid, subjectId.value, fact.id, fact.version)
    toast.add({
      title: fact.supersededBy ? '已恢复生效，取代它的事实仍然有效' : '已恢复生效',
      color: 'success',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复生效失败', color: 'error' })
  } finally {
    reactivating.value = null
    void refreshSubjectCaches(sid)
  }
}

// 合并：选同种类的另一个对象并进来。下拉框打开时才按名字或平台账号去查
const mergeTerm = ref('')
const mergeQuery = useDebounced(mergeTerm)
const mergeOpen = ref(false)
const candidates = useQuery({
  queryKey: computed(() => ['merge-picker', spaceId.value, data.value?.kind, mergeQuery.value]),
  queryFn: () =>
    api.subjects(spaceId.value, { kind: data.value!.kind, q: mergeQuery.value || undefined }),
  enabled: computed(() => canEdit.value && mergeOpen.value && data.value !== null),
})
type Candidate = { label: string; value: string; description: string }
// 选中的单独留着：查找词清空后列表换了一页，选中的那个还要显示名字
const mergePicked = ref<Candidate | null>(null)
const candidateItems = computed(() => {
  const found: Candidate[] = (candidates.data.value?.items ?? [])
    .filter((s) => s.id !== subjectId.value)
    .map((s) => ({
      label: s.displayName,
      value: s.id,
      description: s.identities.map((i) => `${i.platform} ${i.externalId}`).join('、'),
    }))
  const keep = mergePicked.value
  return keep && !found.some((c) => c.value === keep.value) ? [keep, ...found] : found
})
const mergeFrom = ref<string | undefined>()
watch(mergeFrom, (id) => {
  mergePicked.value = id
    ? (candidateItems.value.find((c) => c.value === id) ?? mergePicked.value)
    : null
})
watch(subjectId, () => {
  mergeFrom.value = undefined
  deletingFact.value = null
})
const confirmMerge = ref(false)
const merging = ref(false)
async function merge() {
  const from = mergeFrom.value
  if (!from) return
  const sid = spaceId.value
  merging.value = true
  try {
    await api.mergeSubject(sid, subjectId.value, from)
    toast.add({ title: `已合并「${mergePicked.value?.label ?? '联系人'}」`, color: 'success' })
    mergeFrom.value = undefined
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '合并失败', color: 'error' })
  } finally {
    merging.value = false
    confirmMerge.value = false
    void refreshSubjectCaches(sid)
  }
}

// 一批抽取的结果：只列不为零的几项
function runCounts(run: ExtractionRunInfo): string {
  const parts = [`${run.turns} 轮`]
  if (run.added) parts.push(`新增 ${run.added}`)
  if (run.updated) parts.push(`更新 ${run.updated}`)
  if (run.unchanged) parts.push(`已有 ${run.unchanged}`)
  if (run.dropped) parts.push(`丢弃 ${run.dropped}`)
  if (run.limited) parts.push(`超出每日上限 ${run.limited}`)
  if (run.skippedTurns) parts.push(`${run.skippedTurns} 轮的 Key 已失效`)
  return parts.join(' · ')
}
</script>

<template>
  <UDashboardPanel id="subject">
    <template #header>
      <UDashboardNavbar :title="data?.displayName ?? '联系人'">
        <template #leading>
          <UButton
            :icon="icons.back"
            color="neutral"
            variant="ghost"
            size="sm"
            aria-label="返回联系人列表"
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
                >首次遇到：{{ formatTime(data.createdAt) }}</span
              >
            </div>
          </template>
          <div class="space-y-4">
            <UFormField
              label="名字"
              :help="
                data.nameLocked
                  ? '已手动改名，不再跟随平台上的显示名'
                  : '修改后，不再跟随平台上的显示名'
              "
            >
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
                  <span class="text-muted">未标记为任何成员</span>
                  <UButton
                    v-if="canEdit"
                    size="sm"
                    variant="subtle"
                    :loading="saving"
                    @click="update({ linkedToMe: true }, '已标记为当前账号')"
                    >这是我</UButton
                  >
                </template>
                <template v-else-if="linkedToMe">
                  <UBadge color="primary" variant="subtle">当前账号</UBadge>
                  <!-- 取消自己的标记 viewer 也可以 -->
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="subtle"
                    :loading="saving"
                    @click="update({ linkedToMe: false }, '已取消标记')"
                    >取消标记</UButton
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
                标记后，当前账号的应用会将此人的私聊视为本人对话。
                <Hint>
                  开启「本人私聊时读取画像」的应用还可读取当前账号的个人画像。只能标记为当前账号。
                </Hint>
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

        <UCard v-if="data.kind === 'person'">
          <template #header>
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-medium">账号绑定</h2>
              <UBadge v-if="waitingForMe" color="warning" variant="subtle" size="sm"
                >{{ waitingForMe }} 个待处理</UBadge
              >
            </div>
          </template>
          <p class="mb-2 text-xs text-muted">
            在 Bot 私聊中发送 /bind 获取绑定码，可将其他平台的账号合并到此联系人。
            <Hint>
              到另一平台私聊同一 Bot，发送 /bind
              加绑定码，核对绑定目标后再发送一次确认，该平台账号即合并到申请绑定码的联系人。申请方已标记为成员、另一方未标记为同一成员时，还需该成员本人在此处或概览中确认后才会合并。
            </Hint>
          </p>
          <SubjectBindings
            v-if="data.bindings.length"
            :space-id="spaceId"
            :items="data.bindings"
            :subject-id="subjectId"
          />
          <p v-else class="text-sm text-muted">暂无绑定记录</p>
        </UCard>

        <UCard v-if="canEdit">
          <template #header><h2 class="text-sm font-medium">合并</h2></template>
          <p class="mb-3 text-xs text-muted">
            同一{{ data.kind === 'group' ? '群' : '人' }}在其他平台的账号可合并到「{{
              data.displayName
            }}」，合并后不可撤销。
            <Hint>
              被合并方的平台账号、事实、{{
                data.kind === 'group' ? '群内' : '私聊中'
              }}记下的内容都转到「{{ data.displayName }}」名下，被合并方随即删除。<template
                v-if="data.kind === 'group'"
                >按群切换人格的规则也随之转移，两边都有规则时保留当前这边的。</template
              >
            </Hint>
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <USelectMenu
              v-model="mergeFrom"
              v-model:search-term="mergeTerm"
              v-model:open="mergeOpen"
              :items="candidateItems"
              value-key="value"
              ignore-filter
              :search-input="{
                name: 'merge-q',
                placeholder: '名字或平台账号',
                loading: candidates.isFetching.value,
              }"
              :placeholder="data.kind === 'group' ? '选择要合并的群' : '选择要合并的人'"
              aria-label="选择要合并的联系人"
              class="w-full sm:w-64"
            />
            <UButton variant="subtle" :disabled="!mergeFrom" @click="confirmMerge = true"
              >合并</UButton
            >
          </div>
        </UCard>

        <UCard>
          <template #header>
            <h2 class="text-sm font-medium">记下的事实（{{ data.factCount }}）</h2>
          </template>
          <p v-if="data.factCount > data.facts.length" class="mb-2 text-xs text-muted">
            仅显示最近更新的 {{ data.facts.length }} 条
          </p>
          <p v-if="!data.facts.length" class="text-sm text-muted">暂无事实</p>
          <ul v-else class="divide-y divide-default">
            <li v-for="fact in data.facts" :key="fact.id" class="flex gap-2 py-2">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm whitespace-pre-wrap">{{ fact.content }}</p>
                <p class="flex flex-wrap gap-2 text-xs text-muted">
                  <span>{{ originScopeText(fact.scope) }}</span>
                  <span>{{ provenanceLabels[fact.provenance] }}</span>
                  <span>{{ formatRelative(fact.updatedAt) }}</span>
                </p>
              </div>
              <UButton
                v-if="canEdit"
                :icon="icons.remove"
                color="neutral"
                variant="ghost"
                size="sm"
                :aria-label="`删除事实：${fact.content}`"
                @click="deletingFact = fact"
              />
            </li>
          </ul>
        </UCard>

        <UCard v-if="data.supersededFacts.length">
          <template #header>
            <h2 class="text-sm font-medium">已被取代的事实（{{ data.supersededFacts.length }}）</h2>
          </template>
          <p class="mb-2 text-xs text-muted">
            这些事实已被后来的内容取代，不再注入对话。
            <Hint>
              恢复生效后，与取代它的事实同时有效，可删除不需要的一条。超过保留期后将被清理。
            </Hint>
          </p>
          <ul class="divide-y divide-default">
            <li v-for="fact in data.supersededFacts" :key="fact.id" class="flex gap-2 py-2">
              <div class="min-w-0 flex-1 space-y-1">
                <p class="text-sm whitespace-pre-wrap text-muted">{{ fact.content }}</p>
                <p v-if="fact.supersededBy" class="text-xs text-muted">
                  已被「{{ fact.supersededBy }}」取代
                </p>
                <p class="flex flex-wrap gap-2 text-xs text-muted">
                  <span>{{ originScopeText(fact.scope) }}</span>
                  <span>{{ provenanceLabels[fact.provenance] }}</span>
                  <span>
                    被取代于
                    <time :datetime="fact.supersededAt" :title="formatTime(fact.supersededAt)">
                      {{ formatRelative(fact.supersededAt) }}
                    </time>
                  </span>
                </p>
              </div>
              <UButton
                v-if="canEdit"
                :icon="icons.reactivate"
                color="neutral"
                variant="subtle"
                size="sm"
                class="shrink-0 self-start"
                :loading="reactivating === fact.id"
                @click="reactivateFact(fact)"
              >
                恢复生效
              </UButton>
            </li>
          </ul>
        </UCard>

        <UCard v-if="data.summaries.length">
          <template #header>
            <h2 class="text-sm font-medium">
              {{ data.kind === 'group' ? '群聊的会话摘要' : '私聊的会话摘要' }}
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
            <h2 class="text-sm font-medium">最近抽取</h2>
          </template>
          <p v-if="!data.runs.length" class="text-sm text-muted">暂无相关抽取</p>
          <ul v-else class="divide-y divide-default">
            <li v-for="run in data.runs" :key="run.id" class="space-y-1 py-2 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                <span>{{ formatTime(run.createdAt) }}</span>
                <span class="text-muted">{{ run.app?.name ?? '已删除的应用' }}</span>
                <span class="text-muted">{{ originScopeText(run.scope) }}</span>
                <UBadge v-if="run.summaryOnly" color="warning" variant="subtle" size="sm"
                  >预算已用完，仅写入摘要</UBadge
                >
                <UBadge v-else-if="run.summarized" color="neutral" variant="subtle" size="sm"
                  >已写入摘要</UBadge
                >
              </div>
              <p class="text-xs text-muted">{{ runCounts(run) }}</p>
              <p v-if="run.error" class="text-xs text-error">{{ run.error }}</p>
            </li>
          </ul>
        </UCard>
      </div>
      <UModal
        :open="deletingFact !== null"
        title="删除这条事实？"
        @update:open="(v) => !v && (deletingFact = null)"
      >
        <template #body>
          <p class="text-sm">
            删除后，「{{ deletingFact?.content }}」不再注入对话，也无法在管理界面恢复。
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="deletingFact = null">取消</UButton>
            <UButton color="error" :loading="removing" @click="removeFact">删除</UButton>
          </div>
        </template>
      </UModal>
      <UModal
        :open="confirmMerge"
        title="合并联系人？"
        @update:open="(v) => !v && (confirmMerge = false)"
      >
        <template #body>
          <p class="text-sm">
            将「{{ mergePicked?.label }}」合并到「{{ data?.displayName }}」：平台账号与事实转到「{{
              data?.displayName
            }}」，「{{ mergePicked?.label }}」随即删除，相关的待确认绑定作废。此操作不可撤销。
          </p>
          <p v-if="data?.kind === 'group'" class="mt-2 text-sm text-muted">
            「{{ mergePicked?.label }}」群内记下的内容归到「{{
              data?.displayName
            }}」，此后在这个群的任一平台都能读取。按群切换人格的规则一并转移；两边在同一应用都有规则时，保留「{{
              data?.displayName
            }}」的规则。
          </p>
          <p v-else class="mt-2 text-sm text-muted">
            合并后这些平台账号算同一个人：私聊中记下的内容，用哪个账号私聊都能读取；任一方标记过成员时，这些账号的私聊都视为该成员本人对话。在群里记下的事实归到「{{
              data?.displayName
            }}」，可见范围不变，仍只在那个群可见。
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="confirmMerge = false">取消</UButton>
            <UButton color="error" :loading="merging" @click="merge">合并</UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
