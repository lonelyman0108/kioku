<script setup lang="ts">
import type { DeviceGrantApproved, DeviceGrantInfo, KeyScopes } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { refreshAppCaches } from '../appQueries'
import {
  GRANT_GONE,
  NEW_APP,
  USER_CODE_PROBLEM,
  appSlugProblem,
  approveBody,
  defaultAppSlug,
  defaultGrantPreset,
  defaultGrantScopes,
  defaultKeyName,
  defaultSpaceId,
  displayUserCode,
  grantApps,
  grantFailure,
  isGrantExpired,
  issuableSpaces,
  lookupFailure,
  nameProblem,
  normalizeUserCode,
  runtimeNames,
} from '../authorize'
import Hint from '../components/Hint.vue'
import KeyScopeEditor from '../components/KeyScopeEditor.vue'
import {
  CREDENTIAL_CAPABILITY_HINT,
  issuedCredentialCapability,
  matchPreset,
  tightenScopes,
} from '../components/keyPresets'
import EntryFrame from '../components/strata/EntryFrame.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import PropertyList, { type Property } from '../components/strata/PropertyList.vue'
import ScopeTags from '../components/strata/ScopeTags.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { formatTime } from '../time'

// 浏览器授权的确认页：输入终端里显示的确认码，看到这条申请，选空间、应用与签发范围后确认或拒绝。
// 访问密钥由命令行取走，这里拿不到、也不显示。
// 确认码只从输入框来，不从地址读：别人发来的链接带不了确认码，要对着自己的终端输入。
// 不在外壳里（不带空间），但要登录：路由守卫带人去登录页，登录后回到这里
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const { me, space: lastSpace } = useSession()

// 会话失效（过期、在别的标签页退出）：回登录页，登录后回来重新输入确认码
watch(
  () => me.data.value,
  (value) => {
    if (value === null) void router.replace({ name: 'login', query: { next: route.path } })
  },
)

type Step = 'code' | 'review' | 'approved' | 'denied'
const step = ref<Step>('code')

// 第一步：输入确认码
const codeInput = ref('')
const codeError = ref<string | null>(null)
// 从第二步退回来时的说明（申请过期了）
const notice = ref<string | null>(null)
const looking = ref(false)
// 规整后的确认码与查到的申请；确认、拒绝都带着这个确认码
const userCode = ref('')
const info = ref<DeviceGrantInfo | null>(null)

async function lookup() {
  if (looking.value) return
  notice.value = null
  const code = normalizeUserCode(codeInput.value)
  if (!code) {
    codeError.value = USER_CODE_PROBLEM
    return
  }
  looking.value = true
  codeError.value = null
  try {
    info.value = await api.lookupDeviceGrant(code)
    userCode.value = code
    resetChoice()
    step.value = 'review'
  } catch (err) {
    codeError.value = lookupFailure(err)
  } finally {
    looking.value = false
  }
}

// 回到第一步：确认码、申请与上一次的选择都清掉
function restart(message: string | null = null) {
  step.value = 'code'
  codeInput.value = ''
  codeError.value = null
  notice.value = message
  userCode.value = ''
  info.value = null
  approved.value = null
  error.value = null
}

// 第二步：空间
const spaces = computed(() => issuableSpaces(me.data.value?.spaces ?? []))
const spaceId = ref<string>()
const spaceItems = computed(() => spaces.value.map((s) => ({ label: s.name, value: s.id })))
const space = computed(() => spaces.value.find((s) => s.id === spaceId.value) ?? null)
const isSpaceOwner = computed(() => space.value?.role === 'owner')

// 应用：这个空间里当前账号自己的、运行时和申请一致的可以直接选，另有新建
const apps = useQuery({
  queryKey: computed(() => ['apps', spaceId.value]),
  queryFn: () => api.apps(spaceId.value!),
  enabled: computed(() => step.value === 'review' && spaceId.value !== undefined),
})
const ownApps = computed(() =>
  info.value ? grantApps(apps.data.value ?? [], me.data.value?.id, info.value.runtimeFamily) : [],
)
const takenSlugs = computed(() => (apps.data.value ?? []).map((app) => app.slug))
const appItems = computed(() => [
  ...ownApps.value.map((app) => ({ label: `${app.name}（app://${app.slug}）`, value: app.id })),
  { label: '新建应用', value: NEW_APP },
])
const appHelp = computed(() => {
  if (!info.value || !apps.isSuccess.value) return undefined
  return ownApps.value.length
    ? `仅列出当前账号的 ${info.value.runtimeFamily} 应用`
    : `当前账号在此空间暂无 ${info.value.runtimeFamily} 应用`
})
// 没选过时：有自己的应用就用第一个，没有就新建。选过的应用不在了（换了空间、被删、转给别人）退回默认
const picked = ref<string | null>(null)
const appChoice = computed({
  get: () =>
    picked.value === NEW_APP || ownApps.value.some((app) => app.id === picked.value)
      ? picked.value!
      : (ownApps.value[0]?.id ?? NEW_APP),
  set: (value: string) => (picked.value = value),
})

// 新建应用与访问密钥的名称：没改过时跟着默认值（标识被占用就换下一个），改过的保留输入
const typed = reactive({
  slug: null as string | null,
  appName: null as string | null,
  keyName: null as string | null,
})
const slug = computed({
  get: () =>
    typed.slug ?? (info.value ? defaultAppSlug(info.value.runtimeFamily, takenSlugs.value) : ''),
  set: (value: string) => {
    typed.slug = value
    slugRejected.value = null
  },
})
const appName = computed({
  get: () => typed.appName ?? (info.value ? runtimeNames[info.value.runtimeFamily] : ''),
  set: (value: string) => (typed.appName = value),
})
const keyName = computed({
  get: () => typed.keyName ?? (info.value ? defaultKeyName(info.value) : ''),
  set: (value: string) => (typed.keyName = value),
})
// 服务端说被占用的那个标识（列表里可能还没有它）与它给的说明。只在输入框里还是这个标识时显示：
// 重取列表之后默认值换成了下一个，旧的说明不该压着新的标识
const slugRejected = ref<{ slug: string; text: string } | null>(null)
const slugProblem = computed(() =>
  slugRejected.value?.slug === slug.value
    ? slugRejected.value.text
    : appSlugProblem(slug.value, takenSlugs.value),
)
const appNameProblem = computed(() => nameProblem(appName.value))
const keyNameProblem = computed(() => nameProblem(keyName.value))

// 签发范围：和签发访问密钥的弹窗是同一个编辑器、同一套模板与收紧规则
const form = reactive({
  preset: defaultGrantPreset(false),
  scopes: defaultGrantScopes(false) as KeyScopes,
})
// 换到不是所有者的空间时收紧：凭据能力、机密级与跨人格写入都不能带过去
watch(isSpaceOwner, (owner) => {
  form.scopes = tightenScopes(form.scopes, owner)
  form.preset = matchPreset(form.scopes, owner)
})
const actualCredentials = computed(() => issuedCredentialCapability(form.scopes))

// 每条申请从默认值开始，不沿用上一条的选择
function resetChoice() {
  spaceId.value = defaultSpaceId(me.data.value?.spaces ?? [], lastSpace.value?.id) ?? undefined
  picked.value = null
  Object.assign(typed, { slug: null, appName: null, keyName: null })
  slugRejected.value = null
  form.scopes = defaultGrantScopes(isSpaceOwner.value)
  form.preset = defaultGrantPreset(isSpaceOwner.value)
  error.value = null
}

// 申请的事实：一项一行，不拼成一句
const facts = computed<Property[][]>(() => {
  const i = info.value
  if (!i) return []
  return [
    [
      { key: 'code', label: '确认码' },
      { key: 'runtime', label: '运行时', value: i.runtimeFamily },
      { key: 'client', label: '自报名称' },
      { key: 'address', label: '来源地址' },
    ],
    [
      { key: 'created', label: '申请时间', value: formatTime(i.createdAt) },
      { key: 'expires', label: '到期时间' },
    ],
  ]
})
const now = useNow(5_000)
const expired = computed(() => (info.value ? isGrantExpired(info.value, now.value) : false))

const error = ref<string | null>(null)
const busy = ref<'approve' | 'deny' | null>(null)
const approved = ref<(DeviceGrantApproved & { spaceId: string; keyName: string }) | null>(null)

const ready = computed(
  () =>
    !!space.value &&
    !expired.value &&
    apps.isSuccess.value &&
    !keyNameProblem.value &&
    (appChoice.value !== NEW_APP || (!slugProblem.value && !appNameProblem.value)),
)

async function approve() {
  if (busy.value || !ready.value || !spaceId.value) return
  busy.value = 'approve'
  error.value = null
  const body = approveBody({
    userCode: userCode.value,
    spaceId: spaceId.value,
    appChoice: appChoice.value,
    newApp: { slug: slug.value, name: appName.value },
    keyName: keyName.value,
    scopes: form.scopes,
  })
  try {
    const result = await api.approveDeviceGrant(body)
    approved.value = { ...result, spaceId: body.spaceId, keyName: body.keyName }
    step.value = 'approved'
    // 可能新建了应用：应用列表要重取
    void refreshAppCaches(queryClient, body.spaceId)
  } catch (err) {
    const failure = grantFailure(err, '确认失败')
    if (failure.kind === 'slug' && 'slug' in body.app) {
      // 409 且是新建应用：标识被占用，写在标识那一栏
      slugRejected.value = { slug: body.app.slug, text: failure.text }
      picked.value = NEW_APP
      void apps.refetch()
    } else if (failure.kind === 'slug') {
      // 409 且选的是已有的应用：它的运行时与申请的不一致（列表过时了），显示说明并重取列表
      error.value = failure.text
      void apps.refetch()
    } else if (failure.kind === 'gone') {
      // 404 可能是申请没了，也可能是选的应用没了：按确认码再查一次才分得清
      try {
        info.value = await api.lookupDeviceGrant(userCode.value)
        error.value = failure.text
        void apps.refetch()
      } catch (again) {
        restart(lookupFailure(again))
      }
    } else {
      error.value = failure.text
    }
  } finally {
    busy.value = null
  }
}

async function deny() {
  if (busy.value) return
  busy.value = 'deny'
  error.value = null
  try {
    await api.denyDeviceGrant(userCode.value)
    step.value = 'denied'
  } catch (err) {
    const failure = grantFailure(err, '拒绝失败')
    if (failure.kind === 'gone') restart(GRANT_GONE)
    else error.value = failure.text
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <EntryFrame :wide="step === 'review'">
    <template v-if="step === 'code'">
      <SectionHeading title="浏览器授权" :level="1" />
      <p class="mt-2 text-sm text-muted">输入终端里显示的确认码，查看这次申请。</p>
      <NoteLine v-if="notice" class="mt-4" tone="warning" role="status" data-state="gone">
        {{ notice }}
        <template #detail>在终端里重新发起申请，再输入新的确认码。</template>
      </NoteLine>
      <!-- 这一步只是查看申请，回车提交没有后果；确认在下一步，不放在表单里 -->
      <form class="mt-4 space-y-4" @submit.prevent="lookup">
        <UFormField label="确认码" :error="codeError ?? undefined">
          <UInput
            v-model="codeInput"
            size="lg"
            class="w-full"
            :ui="{ base: 'font-mono uppercase tracking-widest' }"
            placeholder="XXXX-XXXX"
            autocomplete="off"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck="false"
            maxlength="64"
            autofocus
          />
        </UFormField>
        <UButton type="submit" size="lg" block :loading="looking">查看申请</UButton>
      </form>
    </template>

    <!-- 不用表单元素：模板卡片、分段按钮是单选，读写是勾选框，输入框里按回车会隐式提交，没看完就确认了。只有点「确认」才确认 -->
    <div v-else-if="step === 'review' && info" class="review" data-state="review">
      <SectionHeading title="确认浏览器授权" :level="1" />
      <PropertyList class="facts" :groups="facts">
        <template #code>
          <code class="code">{{ displayUserCode(userCode) }}</code>
        </template>
        <template #client>
          <template v-if="info.clientName">
            {{ info.clientName }}<span class="aside">命令行自报，未经核实</span>
          </template>
          <span v-else class="text-muted">未提供</span>
        </template>
        <template #address>
          <code v-if="info.clientAddress" class="font-mono">{{ info.clientAddress }}</code>
          <span v-else class="text-muted">未知</span>
        </template>
        <template #expires>
          {{ formatTime(info.expiresAt) }}<span v-if="expired" class="aside">已过期</span>
        </template>
      </PropertyList>

      <NoteLine tone="warning" class="caution">
        确认后，显示此确认码的命令行获得一个访问密钥
        <template #detail>
          它可按下面的签发范围读写记忆。仅在终端显示着同一个确认码、且申请由自己刚刚发起时确认，否则拒绝。
        </template>
      </NoteLine>

      <NoteLine v-if="expired" tone="error" role="alert" data-state="expired">
        申请已过期
        <template #detail>在终端里重新发起申请，再输入新的确认码。</template>
        <template #actions>
          <UButton size="sm" color="neutral" variant="outline" @click="restart()">
            重新输入
          </UButton>
        </template>
      </NoteLine>

      <NoteLine v-if="!spaces.length" data-state="no-space">
        暂无可签发访问密钥的空间
        <template #detail>签发需要空间所有者或编辑者角色。</template>
      </NoteLine>
      <template v-else>
        <div class="fields">
          <UFormField label="空间">
            <USelect
              v-if="spaces.length > 1"
              v-model="spaceId"
              :items="spaceItems"
              class="w-full"
            />
            <p v-else class="only">{{ space?.name }}</p>
          </UFormField>
          <UFormField label="应用" :help="appHelp">
            <USkeleton v-if="apps.isPending.value" class="h-8 w-full" />
            <USelect
              v-else-if="ownApps.length"
              v-model="appChoice"
              :items="appItems"
              class="w-full"
            />
            <p v-else class="only">新建应用</p>
          </UFormField>
          <template v-if="apps.isSuccess.value && appChoice === NEW_APP">
            <UFormField label="应用名称" :error="appNameProblem ?? undefined">
              <UInput v-model="appName" class="w-full" />
            </UFormField>
            <UFormField
              label="应用标识"
              help="这个应用的记忆位于 app://<标识>/ 下"
              :error="slugProblem ?? undefined"
            >
              <UInput v-model="slug" class="w-full font-mono" spellcheck="false" />
            </UFormField>
          </template>
          <UFormField
            label="访问密钥名称"
            help="用于辨认，例如设备加工具"
            :error="keyNameProblem ?? undefined"
          >
            <UInput v-model="keyName" class="w-full" />
          </UFormField>
        </div>
        <ReadFailureNote
          v-if="apps.isError.value"
          :query="apps"
          fallback="应用读取失败"
          data-state="apps-failed"
        />

        <KeyScopeEditor
          v-model:scopes="form.scopes"
          v-model:preset="form.preset"
          :is-space-owner="isSpaceOwner"
        />
      </template>

      <p v-if="error" class="text-error" role="alert" data-state="failed">{{ error }}</p>
      <div class="foot">
        <div v-if="spaces.length" class="summary">
          <span class="sr-only">签发范围</span>
          <ScopeTags :scopes="form.scopes" :credentials="actualCredentials" />
          <Hint label="凭据能力说明">{{ CREDENTIAL_CAPABILITY_HINT }}</Hint>
        </div>
        <div class="actions">
          <UButton color="neutral" variant="outline" :loading="busy === 'deny'" @click="deny">
            拒绝
          </UButton>
          <UButton
            v-if="spaces.length"
            :loading="busy === 'approve'"
            :disabled="!ready"
            @click="approve"
          >
            确认
          </UButton>
        </div>
      </div>
    </div>

    <template v-else-if="step === 'approved' && approved">
      <SectionHeading title="已确认" :level="1" />
      <p class="mt-4" role="status" data-state="approved">
        回到终端继续。访问密钥由命令行取走，这里不显示。
      </p>
      <PropertyList
        class="mt-4"
        :groups="[
          [
            { key: 'app', label: '应用', value: approved.app.name },
            { key: 'key', label: '访问密钥', value: approved.keyName },
          ],
        ]"
      />
      <div class="mt-6 flex flex-wrap gap-2">
        <UButton color="neutral" variant="outline" @click="restart()">再处理一个</UButton>
        <UButton
          color="neutral"
          variant="ghost"
          :to="{ name: 'app', params: { spaceId: approved.spaceId, appId: approved.app.id } }"
        >
          查看应用
        </UButton>
      </div>
    </template>

    <template v-else>
      <SectionHeading title="已拒绝" :level="1" />
      <p class="mt-4" role="status" data-state="denied">这次申请已作废，命令行不会获得访问密钥。</p>
      <UButton class="mt-6" color="neutral" variant="outline" @click="restart()">
        再处理一个
      </UButton>
    </template>
  </EntryFrame>
</template>

<style scoped>
.review {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.facts {
  max-width: 34rem;
}
.code {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ui-text-highlighted);
}
.aside {
  margin-left: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.note-line {
  margin-bottom: 0;
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 20px;
}
.only {
  font-size: 14px;
  line-height: 32px;
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--strata-rule);
}
.summary {
  display: flex;
  flex: 1 1 18rem;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}
@media (max-width: 639.98px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
