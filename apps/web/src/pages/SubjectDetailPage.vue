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
import NoteLine from '../components/strata/NoteLine.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import StrataStrip from '../components/strata/StrataStrip.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { originScopeText, provenanceLabels } from '../labels'
import { refreshSubjectCaches as refreshCaches } from '../subjectQueries'
import { formatRelative, formatShort, formatTime } from '../time'

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
  <div class="subject-page">
    <div v-if="subject.isPending.value" class="page-note space-y-3">
      <USkeleton class="h-8 w-1/4" />
      <USkeleton class="h-40 w-full" />
    </div>
    <div v-else-if="subject.isError.value || !data" class="page-note">
      <RouterLink :to="{ name: 'subjects', params: { spaceId } }" class="back-link">
        返回联系人列表
      </RouterLink>
      <NoteLine tone="error" class="mt-3">
        {{ subject.error.value instanceof ApiError ? subject.error.value.message : '读取失败' }}
      </NoteLine>
    </div>
    <template v-else>
      <StrataStrip layer="subject" sensitivity="public" />
      <header class="subject-head">
        <div class="min-w-0">
          <nav class="crumbs" aria-label="路径">
            <RouterLink :to="{ name: 'subjects', params: { spaceId } }">联系人</RouterLink>
            <i aria-hidden="true">›</i>
            <span>{{ data.kind === 'group' ? '群' : '人' }}</span>
          </nav>
          <h1>{{ data.displayName }}</h1>
        </div>
        <dl class="head-stats">
          <div>
            <dt>事实</dt>
            <dd class="font-mono">{{ data.factCount }}</dd>
          </div>
          <div>
            <dt>平台账号</dt>
            <dd class="font-mono">{{ data.identities.length }}</dd>
          </div>
          <div>
            <dt>首次遇到</dt>
            <dd>
              <time :datetime="data.createdAt" :title="formatTime(data.createdAt)">
                {{ formatRelative(data.createdAt) }}
              </time>
            </dd>
          </div>
        </dl>
      </header>

      <div class="subject-body">
        <!-- 这个联系人是谁：名字、标记、账号，以及绑定与合并 -->
        <div class="subject-side">
          <section>
            <SectionHeading title="资料" />
            <div class="profile-row">
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
                    color="primary"
                    variant="outline"
                    class="shrink-0"
                    :loading="saving"
                    :disabled="!name.trim() || name.trim() === data.displayName"
                    @click="update({ displayName: name.trim() }, '已改名')"
                    >保存</UButton
                  >
                </div>
              </UFormField>
            </div>

            <div v-if="data.kind === 'person'" class="profile-row">
              <p class="row-label">这是我</p>
              <div class="mark-state">
                <template v-if="!data.account">
                  <span class="text-muted">未标记为任何成员</span>
                  <UButton
                    v-if="canEdit"
                    size="sm"
                    color="primary"
                    variant="outline"
                    :loading="saving"
                    @click="update({ linkedToMe: true }, '已标记为当前账号')"
                    >这是我</UButton
                  >
                </template>
                <template v-else-if="linkedToMe">
                  <span class="mark-me">当前账号</span>
                  <!-- 取消自己的标记 viewer 也可以 -->
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="outline"
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
                    variant="outline"
                    :loading="saving"
                    @click="update({ linkedToMe: false }, '已取消标记')"
                    >取消标记</UButton
                  >
                </template>
              </div>
              <p class="row-note">
                标记后，当前账号的应用会将此人的私聊视为本人对话。<Hint>
                  开启「本人私聊时读取画像」的应用还可读取当前账号的个人画像。只能标记为当前账号。
                </Hint>
              </p>
            </div>

            <div class="profile-row">
              <p class="row-label">平台账号</p>
              <ul v-if="data.identities.length" class="accounts">
                <li
                  v-for="identity in data.identities"
                  :key="`${identity.platform}:${identity.externalId}`"
                >
                  <span class="account-platform" :title="identity.platform">
                    {{ identity.platform }}
                  </span>
                  <span class="account-id">{{ identity.externalId }}</span>
                  <span
                    v-if="identity.displayName"
                    class="account-name"
                    :title="identity.displayName"
                  >
                    {{ identity.displayName }}
                  </span>
                </li>
              </ul>
              <p v-else class="text-muted">无平台账号</p>
            </div>
          </section>

          <section v-if="data.kind === 'person'">
            <SectionHeading title="账号绑定">
              <template v-if="waitingForMe" #actions>
                <span class="text-warning">{{ waitingForMe }} 个待处理</span>
              </template>
            </SectionHeading>
            <p class="section-note">
              在 Bot 私聊中发送 /bind 获取绑定码，可将其他平台的账号合并到此联系人。<Hint>
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
            <p v-else class="empty">暂无绑定记录</p>
          </section>

          <section v-if="canEdit">
            <SectionHeading title="合并" />
            <p class="section-note">
              同一{{ data.kind === 'group' ? '群' : '人' }}在其他平台的账号可合并到「{{
                data.displayName
              }}」，合并后不可撤销。<Hint>
                被合并方的平台账号、事实、{{
                  data.kind === 'group' ? '群内' : '私聊中'
                }}记下的内容都转到「{{ data.displayName }}」名下，被合并方随即删除。<template
                  v-if="data.kind === 'group'"
                  >按群切换人格的规则也随之转移，两边都有规则时保留当前这边的。</template
                >
              </Hint>
            </p>
            <div class="merge-form">
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
                class="min-w-0 flex-1"
              />
              <UButton
                color="primary"
                variant="outline"
                class="shrink-0"
                :disabled="!mergeFrom"
                @click="confirmMerge = true"
                >合并</UButton
              >
            </div>
          </section>
        </div>

        <!-- 记下了什么：事实、摘要与抽取记录 -->
        <div class="subject-main">
          <section>
            <SectionHeading :title="`记下的事实（${data.factCount}）`">
              <template #actions>
                <StrataSwatch layer="subject" plain label="layer" />
              </template>
            </SectionHeading>
            <p v-if="data.factCount > data.facts.length" class="section-note">
              仅显示最近更新的 {{ data.facts.length }} 条
            </p>
            <p v-if="!data.facts.length" class="empty">暂无事实</p>
            <ul v-else>
              <li v-for="fact in data.facts" :key="fact.id" class="entry-row">
                <div class="entry-body">
                  <p class="entry-text">{{ fact.content }}</p>
                  <p class="entry-meta">
                    <span>{{ originScopeText(fact.scope) }}</span>
                    <span>{{ provenanceLabels[fact.provenance] }}</span>
                    <time :datetime="fact.updatedAt" :title="formatTime(fact.updatedAt)">
                      {{ formatRelative(fact.updatedAt) }}
                    </time>
                  </p>
                </div>
                <UButton
                  v-if="canEdit"
                  :icon="icons.remove"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  class="shrink-0 text-muted hover:text-error"
                  :aria-label="`删除事实：${fact.content}`"
                  @click="deletingFact = fact"
                />
              </li>
            </ul>
          </section>

          <section v-if="data.supersededFacts.length">
            <SectionHeading :title="`已被取代的事实（${data.supersededFacts.length}）`" />
            <p class="section-note">
              这些事实已被后来的内容取代，不再注入对话。<Hint>
                恢复生效后，与取代它的事实同时有效，可删除不需要的一条。超过保留期后将被清理。
              </Hint>
            </p>
            <ul>
              <li v-for="fact in data.supersededFacts" :key="fact.id" class="entry-row">
                <div class="entry-body">
                  <p class="entry-text text-muted">{{ fact.content }}</p>
                  <p v-if="fact.supersededBy" class="entry-meta">
                    已被「{{ fact.supersededBy }}」取代
                  </p>
                  <p class="entry-meta">
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
                  color="neutral"
                  variant="outline"
                  size="xs"
                  class="shrink-0 self-start"
                  :loading="reactivating === fact.id"
                  @click="reactivateFact(fact)"
                >
                  恢复生效
                </UButton>
              </li>
            </ul>
          </section>

          <section v-if="data.summaries.length">
            <SectionHeading :title="data.kind === 'group' ? '群聊的会话摘要' : '私聊的会话摘要'">
              <template #actions>
                <StrataSwatch layer="episode" plain label="layer" />
              </template>
            </SectionHeading>
            <ul>
              <li v-for="summary in data.summaries" :key="summary.id" class="entry-row">
                <div class="entry-body">
                  <p class="entry-text">{{ summary.content }}</p>
                  <p class="entry-meta">
                    <time :datetime="summary.createdAt" :title="formatTime(summary.createdAt)">
                      {{ formatRelative(summary.createdAt) }}
                    </time>
                    <span v-if="summary.expiresAt"> {{ formatTime(summary.expiresAt) }} 到期 </span>
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
                    <span class="text-default">{{ run.app?.name ?? '已删除的应用' }}</span>
                    <span>{{ originScopeText(run.scope) }}</span>
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
      </div>
    </template>
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

<style scoped>
.subject-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.page-note {
  padding: 24px 32px;
}
.back-link,
.crumbs a {
  color: var(--ui-text-muted);
}
.back-link:hover,
.crumbs a:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.subject-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px 32px;
  padding: 14px 32px 16px;
}
.crumbs {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.subject-head h1 {
  font-size: 28px;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: -0.005em;
  overflow-wrap: anywhere;
}
.head-stats {
  display: flex;
  gap: 28px;
}
.head-stats dt {
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.head-stats dd {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
  white-space: nowrap;
}
.subject-body {
  display: grid;
  grid-template-columns: 400px minmax(0, 1fr);
  align-items: start;
  gap: 0 36px;
  padding: 2px 32px 40px;
}
.subject-side,
.subject-main {
  min-width: 0;
}
.subject-side section + section,
.subject-main section + section {
  margin-top: 26px;
}
.profile-row {
  padding: 11px 0 12px;
  border-bottom: 1px solid var(--ui-border);
}
.row-label {
  margin-bottom: 3px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.25rem;
}
.mark-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
  min-height: 28px;
  overflow-wrap: anywhere;
}
.mark-me {
  padding: 0 6px;
  border: 1px solid var(--strata-rule);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
}
.row-note,
.section-note {
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.row-note {
  margin-top: 4px;
}
.section-note {
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--ui-border);
}
.accounts li {
  display: grid;
  grid-template-columns: 5.5rem minmax(0, 1fr) auto;
  column-gap: 8px;
  align-items: baseline;
  padding: 2px 0;
  line-height: 1.6;
}
.account-platform {
  overflow: hidden;
  font-size: 13px;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-id {
  font-family: var(--font-mono);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.account-name {
  max-width: 8em;
  overflow: hidden;
  font-size: 13px;
  color: var(--ui-text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.merge-form {
  display: flex;
  gap: 8px;
  padding-top: 11px;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.entry-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--ui-border);
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
.text-default {
  color: var(--ui-text);
}

/* 窄屏放不下两栏：上下排 */
@media (max-width: 1023.98px) {
  .page-note {
    padding: 16px;
  }
  .subject-head {
    padding: 12px 16px 14px;
  }
  .subject-head h1 {
    font-size: 23px;
  }
  .subject-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 26px 0;
    padding: 0 16px 32px;
  }
}
</style>
