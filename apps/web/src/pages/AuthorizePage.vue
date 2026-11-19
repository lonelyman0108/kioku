<script setup lang="ts">
import type {
  CircleSummary,
  DeviceGrantApproved,
  DeviceGrantInfo,
  LensKeyScopes,
  LinkedCircleGrant,
  LinkedCircleMode,
  RuntimeFamily,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import { refreshClientCaches } from '../appQueries'
import {
  DUPLICATE_SLUG,
  GRANT_GONE,
  NEW_CLIENT,
  NOTHING_SELECTED,
  USER_CODE_PROBLEM,
  approveBody,
  clientSlugProblem,
  defaultCircleId,
  defaultClientChoice,
  defaultClientName,
  defaultGrantPreset,
  defaultGrantScopes,
  defaultKeyName,
  displayUserCode,
  grantClients,
  grantFailure,
  isGrantExpired,
  issuableCircles,
  lookupFailure,
  nameProblem,
  newClientSlugs,
  normalizeUserCode,
  nothingSelected,
  runtimeNames,
  type PlatformChoice,
} from '../authorize'
import FacetWhenPicker from '../components/FacetWhenPicker.vue'
import Hint from '../components/Hint.vue'
import KeyScopeEditor from '../components/KeyScopeEditor.vue'
import {
  CREDENTIAL_CAPABILITY_HINT,
  issuedCredentialCapability,
  matchPreset,
  tightenScopes,
} from '../components/keyPresets'
import RuntimeIcon from '../components/RuntimeIcon.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import EntryFrame from '../components/strata/EntryFrame.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import PropertyList, { type Property } from '../components/strata/PropertyList.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import ScopeTags from '../components/strata/ScopeTags.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { circleKindLabels } from '../labels'
import { formatTime } from '../time'

// 浏览器授权的确认页：确认码只从输入框来，不在地址或路由参数里传递
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const { me, circle: lastCircle } = useSession()

watch(
  () => me.data.value,
  (value) => {
    if (value === null) void router.replace({ name: 'login', query: { next: route.path } })
  },
)

type Step = 'code' | 'review' | 'approved' | 'denied'
const step = ref<Step>('code')

const codeInput = ref('')
const codeError = ref<string | null>(null)
const notice = ref<string | null>(null)
const looking = ref(false)
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

function restart(message: string | null = null) {
  step.value = 'code'
  codeInput.value = ''
  codeError.value = null
  notice.value = message
  userCode.value = ''
  info.value = null
  rows.value = []
  linkedCircles.value = []
  contextFacets.value = {}
  approved.value = null
  error.value = null
}

// 第二步：主场记忆圈与客场关联
const allCircles = computed(() => me.data.value?.circles ?? [])
const circles = computed(() => issuableCircles(allCircles.value))
const circleId = ref<string>()
const circleItems = computed(() =>
  circles.value.map((s) => ({
    label: s.kind === 'personal' ? `${s.name}（个人圈）` : s.name,
    value: s.id,
  })),
)
const activeCircle = computed(() => circles.value.find((s) => s.id === circleId.value) ?? null)
const isCircleOwner = computed(() => activeCircle.value?.role === 'owner')

const linkedCircles = ref<LinkedCircleGrant[]>([])
const contextFacets = ref<Record<string, string[]>>({})
const otherCircles = computed(() => allCircles.value.filter((c) => c.id !== circleId.value))

watch(circleId, (cid) => {
  linkedCircles.value = linkedCircles.value.filter((g) => g.circleId !== cid)
})

function isCircleLinked(cid: string): boolean {
  return linkedCircles.value.some((g) => g.circleId === cid)
}
function linkedMode(cid: string): LinkedCircleMode {
  return linkedCircles.value.find((g) => g.circleId === cid)?.mode ?? 'read'
}
function toggleLinkedCircle(c: CircleSummary, checked: boolean) {
  if (!checked) {
    linkedCircles.value = linkedCircles.value.filter((g) => g.circleId !== c.id)
    return
  }
  if (!isCircleLinked(c.id)) {
    linkedCircles.value = [...linkedCircles.value, { circleId: c.id, mode: 'read' }]
  }
}
function setLinkedMode(cid: string, mode: LinkedCircleMode) {
  linkedCircles.value = linkedCircles.value.map((g) => (g.circleId === cid ? { ...g, mode } : g))
}

const clients = useQuery({
  queryKey: computed(() => ['clients', circleId.value] as const),
  queryFn: () => api.clients(circleId.value!),
  enabled: computed(() => step.value === 'review' && circleId.value !== undefined),
})
const facets = useQuery({
  queryKey: computed(() => ['facets', circleId.value] as const),
  queryFn: () => api.facets(circleId.value!),
  enabled: computed(() => step.value === 'review' && circleId.value !== undefined),
})
const realmTerms = computed(() =>
  (facets.data.value?.terms ?? [])
    .filter((t) => t.dimensionKey === 'realm')
    .map((t) => ({ slug: t.slug, label: t.label })),
)

const takenSlugs = computed(() => (clients.data.value ?? []).map((c) => c.slug))
const machine = computed(() => info.value?.clientName ?? null)

interface ScopeForm {
  preset: string
  scopes: LensKeyScopes
}
interface PlatformRow {
  runtimeFamily: RuntimeFamily
  clientName: string | null
  selected: boolean
  picked: string | null
  typed: { slug: string | null; clientName: string | null; keyName: string | null }
  form: ScopeForm
  slugRejected: { slug: string; text: string } | null
}
const rows = ref<PlatformRow[]>([])

const ownClients = (runtimeFamily: RuntimeFamily) =>
  grantClients(clients.data.value ?? [], me.data.value?.id, runtimeFamily)
const clientItems = (runtimeFamily: RuntimeFamily) => [
  ...ownClients(runtimeFamily).map((c) => ({
    label: `${c.name}（${c.slug}）`,
    value: c.id,
  })),
  { label: '新建接入实例', value: NEW_CLIENT },
]
const clientChoice = (row: PlatformRow) =>
  row.picked !== null &&
  (row.picked === NEW_CLIENT || ownClients(row.runtimeFamily).some((c) => c.id === row.picked))
    ? row.picked
    : defaultClientChoice(ownClients(row.runtimeFamily), row.runtimeFamily, machine.value)
const clientName = (row: PlatformRow) =>
  row.typed.clientName ?? defaultClientName(row.runtimeFamily, machine.value)
const keyName = (row: PlatformRow) =>
  row.typed.keyName ?? defaultKeyName(machine.value, row.runtimeFamily)

const slugs = computed(() =>
  newClientSlugs(
    rows.value.map((row) => ({
      isNew: row.selected && clientChoice(row) === NEW_CLIENT,
      typed: row.typed.slug,
      runtimeFamily: row.runtimeFamily,
      clientName: clientName(row),
    })),
    takenSlugs.value,
  ),
)
const slugProblems = computed(() =>
  rows.value.map((row, index) => {
    const slug = slugs.value[index]
    if (slug == null) return null
    if (row.slugRejected?.slug === slug) return row.slugRejected.text
    return (
      clientSlugProblem(slug, takenSlugs.value) ??
      (slugs.value.some((other, j) => j !== index && other === slug) ? DUPLICATE_SLUG : null)
    )
  }),
)
function setSlug(row: PlatformRow, value: string) {
  row.typed.slug = value
  row.slugRejected = null
}

const sameScopes = ref(true)
const shared = reactive<ScopeForm>({
  preset: defaultGrantPreset(false),
  scopes: defaultGrantScopes(false),
})
const scopesOf = (row: PlatformRow) => (sameScopes.value ? shared.scopes : row.form.scopes)
watch(sameScopes, (same) => {
  if (same) return
  for (const row of rows.value) {
    row.form = { preset: shared.preset, scopes: { ...shared.scopes } }
  }
})
const tighten = (form: ScopeForm, owner: boolean) => {
  form.scopes = tightenScopes(form.scopes, owner)
  form.preset = matchPreset(form.scopes, owner)
}
watch(isCircleOwner, (owner) => {
  tighten(shared, owner)
  for (const row of rows.value) tighten(row.form, owner)
})
const sharedCredentials = computed(() => issuedCredentialCapability(shared.scopes))

function resetChoice() {
  circleId.value = defaultCircleId(me.data.value?.circles ?? [], lastCircle.value?.id) ?? undefined
  const owner = isCircleOwner.value
  shared.scopes = defaultGrantScopes(owner)
  shared.preset = defaultGrantPreset(owner)
  sameScopes.value = true
  linkedCircles.value = []
  contextFacets.value = {}
  rows.value = (info.value?.platforms ?? []).map((platform) => ({
    runtimeFamily: platform.runtimeFamily,
    clientName: platform.clientName,
    selected: true,
    picked: null,
    typed: { slug: null, clientName: null, keyName: null },
    form: { preset: shared.preset, scopes: { ...shared.scopes } },
    slugRejected: null,
  }))
  error.value = null
}

const choices = computed<PlatformChoice[]>(() =>
  rows.value.map((row, index) => ({
    runtimeFamily: row.runtimeFamily,
    selected: row.selected,
    clientChoice: clientChoice(row),
    newClient: { slug: slugs.value[index] ?? '', name: clientName(row) },
    keyName: keyName(row),
    scopes: scopesOf(row),
  })),
)
const noneSelected = computed(() => nothingSelected(rows.value))
const rowProblem = (row: PlatformRow, index: number) =>
  row.selected &&
  (!!nameProblem(keyName(row)) ||
    (clientChoice(row) === NEW_CLIENT &&
      (!!slugProblems.value[index] || !!nameProblem(clientName(row)))))

const facts = computed<Property[][]>(() => {
  const i = info.value
  if (!i) return []
  return [
    [
      { key: 'code', label: '确认码' },
      { key: 'client', label: '机器名' },
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
const approved = ref<(DeviceGrantApproved & { circleId: string }) | null>(null)

const ready = computed(
  () =>
    !!activeCircle.value &&
    !expired.value &&
    clients.isSuccess.value &&
    !noneSelected.value &&
    !rows.value.some(rowProblem),
)

async function approve() {
  if (busy.value || !ready.value || !circleId.value) return
  busy.value = 'approve'
  error.value = null
  const body = approveBody(userCode.value, circleId.value, choices.value, {
    linkedCircles: linkedCircles.value,
    contextFacets: contextFacets.value,
  })
  try {
    const result = await api.approveDeviceGrant(body)
    approved.value = { ...result, circleId: body.circleId }
    step.value = 'approved'
    void refreshClientCaches(queryClient, body.circleId)
  } catch (err) {
    const failure = grantFailure(err, '确认失败')
    const row = rows.value.find((r) => r.runtimeFamily === failure.runtimeFamily)
    const item = body.items.find((i) => i.runtimeFamily === failure.runtimeFamily)
    if (failure.kind === 'slug' && row && item && 'client' in item && 'slug' in item.client) {
      row.slugRejected = { slug: item.client.slug, text: failure.text }
      row.picked = NEW_CLIENT
      void clients.refetch()
    } else if (failure.kind === 'slug') {
      error.value = failure.text
      void clients.refetch()
    } else if (failure.kind === 'gone') {
      try {
        info.value = await api.lookupDeviceGrant(userCode.value)
        error.value = failure.text
        void clients.refetch()
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

    <!-- 不用表单元素：卡片、分段与勾选框里按回车不隐式确认 -->
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
        确认后，显示此确认码的命令行为勾选的每个平台各获得一个访问密钥
        <template #detail>
          它们可按各自的签发范围读写记忆。仅在终端显示着同一个确认码、且申请由自己刚刚发起时确认，否则拒绝。
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

      <NoteLine v-if="!circles.length" data-state="no-circle">
        暂无可签发访问密钥的记忆圈
        <template #detail>签发需要记忆圈所有者或编辑者角色。</template>
      </NoteLine>
      <template v-else>
        <UFormField label="主场记忆圈" class="space-field">
          <USelect
            v-if="circles.length > 1"
            v-model="circleId"
            :items="circleItems"
            value-key="value"
            class="w-full"
          />
          <p v-else class="only">{{ activeCircle?.name }}</p>
        </UFormField>
        <ReadFailureNote
          v-if="clients.isError.value"
          :query="clients"
          fallback="接入实例读取失败"
          data-state="clients-failed"
        />

        <div class="platforms-head">
          <SectionHeading title="平台" :level="2" />
          <USwitch
            v-if="rows.length > 1"
            v-model="sameScopes"
            size="sm"
            label="所有平台用同一套权限"
          />
        </div>
        <section class="platforms" aria-label="平台">
          <div
            v-for="(row, index) in rows"
            :key="row.runtimeFamily"
            class="platform"
            :data-runtime="row.runtimeFamily"
            :data-selected="row.selected"
          >
            <div class="platform-head">
              <RuntimeIcon :family="row.runtimeFamily" :size="17" class="platform-icon" />
              <UCheckbox v-model="row.selected" :label="runtimeNames[row.runtimeFamily]" />
              <span v-if="row.clientName" class="aside">{{ row.clientName }}</span>
              <span v-if="!row.selected" class="aside">不签发</span>
              <ScopeTags
                v-if="row.selected && !sameScopes"
                class="platform-scopes"
                :scopes="row.form.scopes"
                :credentials="issuedCredentialCapability(row.form.scopes)"
              />
            </div>
            <template v-if="row.selected">
              <div class="fields">
                <UFormField>
                  <template #label>
                    接入实例<Hint v-if="clients.isSuccess.value" label="接入实例列表说明">{{
                      ownClients(row.runtimeFamily).length
                        ? `仅列出当前账号的 ${runtimeNames[row.runtimeFamily]} 接入实例`
                        : `当前账号在此记忆圈暂无 ${runtimeNames[row.runtimeFamily]} 接入实例`
                    }}</Hint>
                  </template>
                  <USkeleton v-if="clients.isPending.value" class="h-8 w-full" />
                  <USelect
                    v-else-if="ownClients(row.runtimeFamily).length"
                    :model-value="clientChoice(row)"
                    :items="clientItems(row.runtimeFamily)"
                    value-key="value"
                    class="w-full"
                    @update:model-value="(value: string) => (row.picked = value)"
                  />
                  <p v-else class="only">新建接入实例</p>
                </UFormField>
                <UFormField :error="nameProblem(keyName(row)) ?? undefined">
                  <template #label>
                    访问密钥名称<Hint label="访问密钥名称说明">用于辨认，例如设备加工具</Hint>
                  </template>
                  <UInput
                    :model-value="keyName(row)"
                    class="w-full"
                    @update:model-value="(value: string) => (row.typed.keyName = value)"
                  />
                </UFormField>
                <template v-if="clients.isSuccess.value && clientChoice(row) === NEW_CLIENT">
                  <UFormField
                    label="接入实例名称"
                    :error="nameProblem(clientName(row)) ?? undefined"
                  >
                    <UInput
                      :model-value="clientName(row)"
                      class="w-full"
                      @update:model-value="(value: string) => (row.typed.clientName = value)"
                    />
                  </UFormField>
                  <UFormField :error="slugProblems[index] ?? undefined">
                    <template #label>
                      接入实例标识<Hint label="接入实例标识说明"
                        >用于命令行与接口中识别这个接入实例</Hint
                      >
                    </template>
                    <UInput
                      :model-value="slugs[index] ?? ''"
                      class="w-full font-mono"
                      spellcheck="false"
                      @update:model-value="(value: string) => setSlug(row, value)"
                    />
                  </UFormField>
                </template>
              </div>
              <KeyScopeEditor
                v-if="!sameScopes"
                v-model:scopes="row.form.scopes"
                v-model:preset="row.form.preset"
                :is-circle-owner="isCircleOwner"
                :circle-kind="activeCircle?.kind ?? 'shared'"
                :realm-terms="realmTerms"
              />
            </template>
          </div>
        </section>
        <p v-if="noneSelected" class="text-sm text-error" data-state="none-selected">
          {{ NOTHING_SELECTED }}
        </p>

        <template v-if="sameScopes">
          <SectionHeading title="签发范围" :level="2" />
          <KeyScopeEditor
            v-model:scopes="shared.scopes"
            v-model:preset="shared.preset"
            :is-circle-owner="isCircleOwner"
            :circle-kind="activeCircle?.kind ?? 'shared'"
            :realm-terms="realmTerms"
          />
        </template>

        <div v-if="otherCircles.length" class="lens-extra">
          <SectionHeading title="关联客场记忆圈" :level="2" />
          <ul class="linked-list">
            <li v-for="c in otherCircles" :key="c.id" class="linked-row">
              <UCheckbox
                :model-value="isCircleLinked(c.id)"
                :label="`${c.name}（${circleKindLabels[c.kind]}）`"
                @update:model-value="(v) => toggleLinkedCircle(c, Boolean(v))"
              />
              <USelect
                v-if="isCircleLinked(c.id)"
                :model-value="linkedMode(c.id)"
                :items="[
                  { label: '仅读取', value: 'read' },
                  {
                    label: '可跨圈写入词条',
                    value: 'read_write',
                    disabled: c.role === 'viewer',
                  },
                ]"
                value-key="value"
                size="xs"
                class="w-40"
                @update:model-value="(v) => setLinkedMode(c.id, v as LinkedCircleMode)"
              />
            </li>
          </ul>
        </div>

        <div v-if="circleId" class="lens-extra">
          <SectionHeading title="固定切面透镜" :level="2" />
          <FacetWhenPicker
            v-model="contextFacets"
            :circle-id="circleId"
            :vocabulary="facets.data.value ?? null"
          />
        </div>
      </template>

      <p v-if="error" class="text-error" role="alert" data-state="failed">{{ error }}</p>
      <div class="foot">
        <div v-if="circles.length && sameScopes" class="summary">
          <span class="sr-only">签发范围</span>
          <ScopeTags :scopes="shared.scopes" :credentials="sharedCredentials" />
          <Hint label="凭据能力说明">{{ CREDENTIAL_CAPABILITY_HINT }}</Hint>
        </div>
        <div class="actions">
          <UButton color="neutral" variant="outline" :loading="busy === 'deny'" @click="deny">
            拒绝
          </UButton>
          <UButton
            v-if="circles.length"
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
      <ul class="done mt-4">
        <li v-for="item in approved.items" :key="item.runtimeFamily">
          <PropertyList
            :groups="[
              [
                { key: 'platform', label: '平台' },
                { key: 'client', label: '接入实例' },
                { key: 'access', label: '访问密钥', value: item.keyName },
              ],
            ]"
          >
            <template #platform>
              <RuntimeLabel :family="item.runtimeFamily" :size="15" />
            </template>
            <template #client>
              <ULink
                :to="{
                  name: 'client',
                  params: { circleId: approved.circleId, clientId: item.client.id },
                }"
              >
                {{ item.client.name }}
              </ULink>
            </template>
          </PropertyList>
        </li>
      </ul>
      <div class="mt-6 flex flex-wrap gap-2">
        <UButton color="neutral" variant="outline" @click="restart()">再处理一个</UButton>
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
  gap: 18px;
}
.facts,
.caution {
  margin-top: 0;
}
.code {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.08em;
}
.aside {
  margin-left: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.space-field {
  max-width: 24rem;
}
.only {
  font-size: 14px;
  line-height: 32px;
}
.platforms-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}
.platforms {
  display: grid;
  gap: 10px;
}
.platform {
  border: 1px solid var(--ui-border-accented);
  padding: 12px 14px;
  display: grid;
  gap: 12px;
}
.platform[data-selected='false'] {
  opacity: 0.72;
}
.platform-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.platform-icon {
  display: inline-block;
  flex: none;
  color: var(--ui-text-muted);
}
.platform-scopes {
  margin-left: auto;
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.lens-extra {
  display: grid;
  gap: 10px;
}
.linked-list {
  display: grid;
  gap: 6px;
}
.linked-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--ui-border-accented);
}
.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  padding-top: 8px;
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
.done {
  display: grid;
  gap: 14px;
}
@media (max-width: 639.98px) {
  .fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
