<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { SubjectFact, SupersededFact, UpdateSubjectRequest } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError, retryable } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import PromoteFactModal from '../components/PromoteFactModal.vue'
import SubjectBindings from '../components/SubjectBindings.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import StrataStrip from '../components/strata/StrataStrip.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { useDebounced } from '../composables/useDebounced'
import { useSession } from '../composables/useSession'
import {
  conversationRoute,
  conversationSubline,
  conversationTitle,
  heardFrom,
  runCounts,
} from '../conversations'
import { icons } from '../icons'
import { originScopeText, provenanceLabels } from '../labels'
import { entryRoute } from '../routes'
import { refreshSubjectCaches as refreshCaches } from '../subjectQueries'
import { formatRelative, formatShort, formatTime } from '../time'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, circle } = useSession()
const circleId = computed(() => String(route.params.circleId))
const subjectId = computed(() => String(route.params.subjectId))
const role = computed(() => circle.value?.role ?? 'viewer')
const canEdit = computed(() => role.value === 'owner' || role.value === 'editor')

const subject = useQuery({
  queryKey: computed(() => ['subject', circleId.value, subjectId.value] as const),
  queryFn: () => api.subject(circleId.value, subjectId.value),
})
const data = computed(() => subject.data.value ?? null)
const linkedToMe = computed(() => data.value?.account?.id === me.data.value?.id)

// 换了联系人就重新填；同一个联系人只在输入框没被改动时跟着服务端的名字走，刷新时不冲掉正在输入的内容
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

const refreshSubjectCaches = (cid: string) => refreshCaches(queryClient, cid, subjectId.value)
// 待当前账号确认的绑定：卡片标题上提醒
const waitingForMe = computed(
  () => data.value?.bindings.filter((b) => b.canConfirm || b.canReject).length ?? 0,
)

const saving = ref(false)
async function update(body: UpdateSubjectRequest, done: string) {
  const cid = circleId.value
  const id = subjectId.value
  saving.value = true
  try {
    const saved = await api.updateSubject(cid, id, body)
    // 服务端会去掉首尾空白：输入框换成保存下来的名字，之后才能接着跟服务端同步
    if (body.displayName !== undefined && id === subjectId.value) {
      name.value = saved.displayName
      synced = saved.displayName
    }
    await refreshSubjectCaches(cid)
    toast.add({ title: done, color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

// 提炼为正式词条
const promotingFact = ref<SubjectFact | null>(null)
const promoteOpen = computed({
  get: () => promotingFact.value !== null,
  set: (v: boolean) => {
    if (!v) promotingFact.value = null
  },
})

// 删一条事实：确认框打开时记下这一版，期间被改过服务端会返回冲突
const deletingFact = ref<SubjectFact | null>(null)
const removing = ref(false)
const removeError = ref<string | null>(null)
async function removeFact() {
  const fact = deletingFact.value
  if (!fact || removing.value) return
  const cid = circleId.value
  removing.value = true
  removeError.value = null
  try {
    await api.deleteFact(cid, subjectId.value, fact.id, fact.version)
    deletingFact.value = null
    toast.add({ title: '已删除事实', color: 'success' })
    void refreshSubjectCaches(cid)
  } catch (err) {
    removeError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    removing.value = false
  }
}

// 让一条被推翻的事实重新生效，带上看到的版本：期间被改过服务端会返回冲突
const reactivating = ref<string | null>(null)
async function reactivateFact(fact: SupersededFact) {
  if (reactivating.value) return
  const cid = circleId.value
  reactivating.value = fact.id
  try {
    await api.reactivateFact(cid, subjectId.value, fact.id, fact.version)
    toast.add({
      title: fact.supersededBy ? '已恢复生效，取代它的事实仍然有效' : '已恢复生效',
      color: 'success',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '恢复生效失败', color: 'error' })
  } finally {
    reactivating.value = null
    void refreshSubjectCaches(cid)
  }
}

// 合并：选同种类的另一个联系人并进来（双方均不得标记为其他成员）。下拉框打开时才按名字或平台账号去查
const canMergeCurrent = computed(() => !(data.value?.account && !linkedToMe.value))
const mergeTerm = ref('')
const mergeQuery = useDebounced(mergeTerm)
const mergeOpen = ref(false)
const candidates = useQuery({
  queryKey: computed(() => ['merge-picker', circleId.value, data.value?.kind, mergeQuery.value]),
  queryFn: () =>
    api.subjects(circleId.value, { kind: data.value!.kind, q: mergeQuery.value || undefined }),
  enabled: computed(
    () => canEdit.value && canMergeCurrent.value && mergeOpen.value && data.value !== null,
  ),
})
type Candidate = { label: string; value: string; description: string }
// 选中的单独留着：查找词清空后列表换了一页，选中的那个还要显示名字
const mergePicked = ref<Candidate | null>(null)
const candidateItems = computed(() => {
  const meId = me.data.value?.id
  const found: Candidate[] = (candidates.data.value?.items ?? [])
    .filter((s) => s.id !== subjectId.value && !(s.account && s.account.id !== meId))
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
  removeError.value = null
  confirmMerge.value = false
  mergeError.value = null
  promotingFact.value = null
})
const confirmMerge = ref(false)
const merging = ref(false)
const mergeError = ref<string | null>(null)

const deleteFactConsequences = computed(() => {
  const f = deletingFact.value
  if (!f) return []
  return [
    `「${f.content}」将停止注入后续对话。`,
    '删除后进入已删除列表，可在保留期内前往「记忆 → 已删除」恢复，过期后永久清除。',
  ]
})

const mergeConsequences = computed(() => {
  const fromName = mergePicked.value?.label ?? ''
  const targetName = data.value?.displayName ?? ''
  const lines = [
    `将「${fromName}」合并到「${targetName}」：平台账号与事实转到「${targetName}」，「${fromName}」随即删除，与被合并方相关的待确认绑定作废。此操作不可撤销。`,
  ]
  if (data.value?.kind === 'group') {
    lines.push(
      `「${fromName}」群内记下的内容归到「${targetName}」，此后在该群任一平台都能读取。按群规则一并转移；同一客户端两边都有规则时保留「${targetName}」的规则。`,
    )
  } else {
    lines.push(
      `合并后这些平台账号视作同一人：私聊中记下的内容，用其中任一账号私聊都能读取；任一方已标记为当前账号时，这些账号的私聊都视为当前账号本人对话。群内记下的事实可见范围不变，仍只在原群可见。`,
    )
  }
  return lines
})

async function merge() {
  const from = mergeFrom.value
  if (!from || merging.value) return
  const cid = circleId.value
  merging.value = true
  mergeError.value = null
  try {
    await api.mergeSubject(cid, subjectId.value, from)
    confirmMerge.value = false
    mergeFrom.value = undefined
    toast.add({ title: `已合并「${mergePicked.value?.label ?? '联系人'}」`, color: 'success' })
    void refreshSubjectCaches(cid)
  } catch (err) {
    mergeError.value = err instanceof ApiError ? err.message : '合并失败'
  } finally {
    merging.value = false
  }
}

// 对话页的联系人分页：面包屑与「返回」都回到那里
const contactsRoute = computed(() => ({
  name: 'conversations',
  params: { circleId: circleId.value },
  query: { tab: 'contacts' },
}))
</script>

<template>
  <div class="subject-page">
    <div v-if="subject.isPending.value" class="page-note space-y-3">
      <USkeleton class="h-8 w-1/4" />
      <USkeleton class="h-40 w-full" />
    </div>
    <!--
      没读到过，或者是确定的结果（别处删掉、合并之后的 404）：整块报错，旧内容和操作都不留。
      还能再读的刷新失败才照常显示详情，错误放在上面
    -->
    <div
      v-else-if="!data || (subject.isError.value && !retryable(subject.error.value))"
      class="page-note"
    >
      <RouterLink :to="contactsRoute" class="back-link"> 返回联系人列表 </RouterLink>
      <ReadFailureNote class="mt-3" :query="subject" />
    </div>
    <template v-else>
      <StrataStrip band="fact" sensitivity="public" />
      <header class="subject-head">
        <div class="min-w-0">
          <nav class="crumbs" aria-label="路径">
            <RouterLink :to="contactsRoute">联系人</RouterLink>
            <i aria-hidden="true">›</i>
            <span>{{ data.kind === 'group' ? '群' : '人' }}</span>
          </nav>
          <h1>{{ data.displayName }}</h1>
        </div>
        <dl class="head-stats">
          <div>
            <dt>事实</dt>
            <dd class="tabular-nums">{{ data.factCount }}</dd>
          </div>
          <div>
            <dt>平台账号</dt>
            <dd class="tabular-nums">{{ data.identities.length }}</dd>
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

      <div v-if="subject.isError.value" class="stale-note">
        <ReadFailureNote :query="subject" />
      </div>
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
                  <!-- 取消自己的标记查看者也可以 -->
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
                标记后，当前账号的客户端会将此人的私聊视为本人对话。群内发言人的事实能否被其他群读取，取决于各个
                <RouterLink :to="{ name: 'clients', params: { circleId } }" class="entry-link">
                  客户端
                </RouterLink>
                设置中的「跨群认人 / 按群隔离」模式。<Hint>
                  开启「本人私聊开放内部记忆」的客户端还可读取当前账号的内部及以下记忆。只能标记为当前账号。
                </Hint>
              </p>
            </div>

            <div v-if="data.kind === 'group'" class="profile-row">
              <p class="row-label">按群规则与单群隔离锁</p>
              <p class="row-note">
                为此群单独指定人格或开启单群隔离锁，需在各
                <RouterLink :to="{ name: 'clients', params: { circleId } }" class="entry-link">
                  客户端
                </RouterLink>
                的按群规则中配置。开启单群隔离锁后，其他群开启跨群认人时也不会读到本群的发言人事实。
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
              在与机器人的私聊中发送 /bind 获取绑定码，可将其他平台的账号合并到此联系人。<Hint>
                到另一平台私聊同一个机器人，发送 /bind
                加绑定码，核对绑定目标后再发送一次确认，该平台账号即合并到申请绑定码的联系人。申请方已标记为成员、另一方未标记为同一成员时，还需该成员本人在此处或「待处理」中确认后才会合并。
              </Hint>
            </p>
            <SubjectBindings
              v-if="data.bindings.length"
              :circle-id="circleId"
              :items="data.bindings"
              :subject-id="subjectId"
            />
            <p v-else class="empty">暂无绑定记录</p>
          </section>

          <section v-if="canEdit">
            <SectionHeading title="合并" />
            <NoteLine v-if="!canMergeCurrent" tone="warning" flush class="mt-2">
              当前联系人已标记为其他成员，无法合并。请先让该成员取消标记。
            </NoteLine>
            <template v-else>
              <p class="section-note">
                同一{{ data.kind === 'group' ? '群' : '人' }}在其他平台的账号可合并到「{{
                  data.displayName
                }}」，合并后不可撤销。<Hint>
                  被合并方的平台账号、事实、{{
                    data.kind === 'group' ? '群内' : '私聊中'
                  }}记下的内容都转到「{{
                    data.displayName
                  }}」名下，被合并方随即删除。已标记为其他成员的联系人不参与合并。<template
                    v-if="data.kind === 'group'"
                    >按群规则也随之转移，两边同一客户端都有规则时保留当前这边的。</template
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
                  @click="((confirmMerge = true), (mergeError = null))"
                  >合并</UButton
                >
              </div>
              <ReadFailureNote
                v-if="mergeOpen && candidates.isError.value"
                class="mt-2"
                :query="candidates"
              />
            </template>
          </section>
        </div>

        <!-- 记下了什么：事实、参与的会话与抽取记录 -->
        <div class="subject-main">
          <section>
            <SectionHeading :title="`记下的事实（${data.factCount}）`">
              <template #actions>
                <StrataSwatch band="fact" plain label="band" />
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
                    <RouterLink
                      v-if="fact.shortId"
                      :to="entryRoute(circleId, fact.shortId)"
                      class="short-id entry-link"
                    >
                      {{ fact.shortId }}
                    </RouterLink>
                    <RouterLink
                      v-if="fact.conversationId"
                      :to="conversationRoute(circleId, fact.conversationId)"
                      class="entry-link"
                    >
                      {{ heardFrom(fact.scope) }}
                    </RouterLink>
                    <span v-else>{{ heardFrom(fact.scope) }}</span>
                    <span>{{ provenanceLabels[fact.provenance] }}</span>
                    <time :datetime="fact.updatedAt" :title="formatTime(fact.updatedAt)">
                      {{ formatRelative(fact.updatedAt) }}
                    </time>
                  </p>
                </div>
                <div v-if="canEdit" class="entry-actions">
                  <UButton
                    :icon="icons.promote"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    title="提炼为正式记忆"
                    :aria-label="`提炼为正式记忆：${fact.content}`"
                    @click="promotingFact = fact"
                  />
                  <UButton
                    :icon="icons.remove"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    class="text-muted hover:text-error"
                    :aria-label="`删除事实：${fact.content}`"
                    @click="deletingFact = fact"
                  />
                </div>
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
                    <RouterLink
                      v-if="fact.shortId"
                      :to="entryRoute(circleId, fact.shortId)"
                      class="short-id entry-link"
                    >
                      {{ fact.shortId }}
                    </RouterLink>
                    <span>{{ heardFrom(fact.scope) }}</span>
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

          <section>
            <SectionHeading :title="`参与的会话（${data.conversations.length}）`">
              <template #hint>
                <Hint>
                  {{
                    data.kind === 'group'
                      ? '在这个群里的会话。'
                      : '和此人的私聊，以及此人说过话的群。'
                  }}会话摘要在会话详情中查看。
                </Hint>
              </template>
              <template #actions>
                <StrataSwatch band="episode" plain label="band" />
              </template>
            </SectionHeading>
            <p v-if="!data.conversations.length" class="empty">暂无会话</p>
            <ul v-else>
              <li v-for="c in data.conversations" :key="c.id" class="entry-row">
                <div class="entry-body">
                  <p>
                    <RouterLink :to="conversationRoute(circleId, c.id)" class="entry-link">
                      {{ conversationTitle(c) }}
                    </RouterLink>
                  </p>
                  <p class="entry-meta">
                    <span>{{ conversationSubline(c) }}</span>
                    <span>摘要 {{ c.summaryCount }} 条</span>
                    <time :datetime="c.lastActiveAt" :title="formatTime(c.lastActiveAt)">
                      {{ formatRelative(c.lastActiveAt) }}
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
                    <span class="text-default">{{ run.client?.name ?? '已删除的客户端' }}</span>
                    <RouterLink
                      v-if="run.conversationId"
                      :to="conversationRoute(circleId, run.conversationId)"
                      class="entry-link"
                    >
                      {{ originScopeText(run.scope) }}
                    </RouterLink>
                    <span v-else>{{ originScopeText(run.scope) }}</span>
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

  <PromoteFactModal
    v-if="data"
    v-model:open="promoteOpen"
    :circle-id="circleId"
    :subject-id="subjectId"
    :subject-name="data.displayName"
    :fact="promotingFact"
  />

  <ConsequenceModal
    :open="deletingFact !== null"
    title="删除这条事实？"
    :consequences="deleteFactConsequences"
    action="删除"
    :busy="removing"
    :error="removeError"
    @close="deletingFact = null"
    @confirm="removeFact"
  />
  <ConsequenceModal
    :open="confirmMerge"
    title="合并联系人？"
    :consequences="mergeConsequences"
    action="合并"
    :busy="merging"
    :error="mergeError"
    @close="confirmMerge = false"
    @confirm="merge"
  />
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
.stale-note {
  padding: 0 32px;
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
.entry-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
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
.text-default {
  color: var(--ui-text);
}
.entry-link {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.entry-link:hover {
  color: var(--ui-text-highlighted);
  text-decoration-color: currentColor;
}

/* 窄屏放不下两栏：上下排 */
@media (max-width: 1023.98px) {
  .page-note {
    padding: 16px;
  }
  .stale-note {
    padding: 0 16px;
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
