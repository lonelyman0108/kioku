<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CREDENTIAL_EXPIRING_DAYS,
  CREDENTIAL_ROTATION_NAME,
  type ClientInfo,
  type ConsoleCredential,
  type OrphanVaultItem,
  type VaultItemSummary,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, toRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useNewCredentialStore } from '../composables/useNewCredentialStore'
import { useSession } from '../composables/useSession'
import {
  createBody,
  editableState,
  formProblem,
  mergeReloaded,
  updateBody,
  type CredentialFormInput,
  type CredentialFormMode,
  type CredentialFormState,
  type ValueRow,
  type VaultRow,
  type VaultValueRow,
} from '../credentialForm'
import { icons } from '../icons'
import { invalidateInboxCounts } from '../inbox'
import {
  CREDENTIAL_URL_HINT,
  expiresField,
  expiresInputBad,
  itemFieldLabel,
  itemsAvailable,
  orphanNotice,
  orphanVaultItem,
  storeBlocker,
  storeLabel,
  storeName,
  vaultCredentialDraft,
  writableVaultField,
  writeFailureNext,
} from '../vault'
import { fetchVaultItems } from '../vaultQueries'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'

// 新建凭据、给密码库条目起标识、修改两种凭据共用。修改时打开的那一刻记下这一版：
// 提交用它的版本号，期间别处改过就返回冲突。来源不能改：托管的改值；密码库的改字段对应，值写回原条目。
// 新建的值写到哪里由去处决定（设了去处写进那个集合，没有时由 Kioku 托管），表单里只说明，不让选
const props = defineProps<{
  circleId: string
  credential: ConsoleCredential | null
  // 起标识时的条目与它所在的连接；新建与修改时为 null
  vaultItem: { connectionId: string; item: VaultItemSummary } | null
  clients: ClientInfo[]
  // 已有的标识，起标识时建议的标识避开它们
  identifiers: readonly string[]
}>()
const open = defineModel<boolean>('open', { required: true })
// 事件带上提交时的记忆圈：保存期间切换了记忆圈，页面不能把结果写进新记忆圈
const emit = defineEmits<{
  saved: [credential: ConsoleCredential, circleId: string]
  conflict: []
  'open-vault': []
}>()
const toast = useToast()
const queryClient = useQueryClient()

let nextKey = 0
const mode = ref<CredentialFormMode>({ kind: 'new' })
const form = reactive<CredentialFormState>({
  identifier: '',
  name: '',
  description: '',
  restrictClients: false,
  clientIds: [],
  restrictRealms: false,
  allowedRealms: [],
  url: '',
  expires: expiresField(null),
  needsRotation: false,
})
const valueRows = ref<ValueRow[]>([])
const vaultRows = ref<VaultRow[]>([])
const vaultValues = ref<VaultValueRow[]>([])
const failure = ref<string | null>(null)
const conflict = ref(false)
const failureDetail = ref<string | null>(null)
const orphan = ref<OrphanVaultItem | null>(null)
const mergeNote = ref<{ title: string; conflicts: string[] } | null>(null)

const valueRow = (name = '', existing = false): ValueRow => ({
  key: nextKey++,
  name,
  value: '',
  existing,
  removed: false,
})
const vaultRow = (name: string, itemField: string): VaultRow => ({
  key: nextKey++,
  name,
  itemField,
})

const origin = computed(() => (mode.value.kind === 'edit' ? mode.value.origin : null))
const target = computed(() => (mode.value.kind === 'name-item' ? mode.value : null))
const editing = computed(() => origin.value !== null)
const isNew = computed(() => mode.value.kind === 'new')
const isVault = computed(() =>
  origin.value ? origin.value.source === 'vault' : target.value !== null,
)

function clearValues() {
  for (const row of valueRows.value) row.value = ''
  for (const row of vaultValues.value) row.value = ''
}

function fill(c: ConsoleCredential | null) {
  const item = c ? null : props.vaultItem
  const draft = item ? vaultCredentialDraft(item.item, props.identifiers) : null
  mode.value = c
    ? { kind: 'edit', origin: c }
    : item
      ? { kind: 'name-item', ...item }
      : { kind: 'new' }
  Object.assign(form, {
    identifier: draft?.identifier ?? '',
    url: '',
    ...(c
      ? editableState(c)
      : {
          name: draft?.name ?? '',
          description: '',
          restrictClients: false,
          clientIds: [],
          restrictRealms: false,
          allowedRealms: [],
          expires: expiresField(null),
          needsRotation: false,
        }),
  })
  valueRows.value =
    c?.source === 'hosted'
      ? c.fields.map((f) => valueRow(f.name, true))
      : [valueRow('username'), valueRow('password')]
  vaultRows.value = c
    ? c.fields.flatMap((f) => (f.itemField ? [vaultRow(f.name, f.itemField)] : []))
    : (draft?.fields ?? []).map((f) => vaultRow(f.name, f.itemField!))
  vaultValues.value =
    c?.source === 'vault'
      ? c.fields.flatMap((f) =>
          f.itemField ? [{ name: f.name, itemField: f.itemField, value: '' }] : [],
        )
      : []
  failure.value = null
  conflict.value = false
  orphan.value = null
  mergeNote.value = null
  baselineDone.value = false
}

watch(open, (isOpen) => {
  if (!isOpen) clearValues()
  else fill(props.credential)
})

const editingConnection = computed(() => origin.value?.vault?.connectionId ?? null)
const connections = useQuery({
  queryKey: computed(() => ['vault-connections', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.vaultConnections(cid),
  enabled: computed(() => open.value && (editingConnection.value !== null || isNew.value)),
})
const connection = computed(
  () => connections.data.value?.items.find((x) => x.id === editingConnection.value) ?? null,
)
const items = useQuery({
  queryKey: computed(() => ['vault-items', props.circleId, editingConnection.value] as const),
  queryFn: ({ queryKey: [, cid, id] }) => fetchVaultItems(queryClient, cid, id!),
  enabled: computed(() => open.value && !!connection.value && itemsAvailable(connection.value)),
})

const facets = useQuery({
  queryKey: computed(() => ['facets', props.circleId] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
  enabled: open,
})
const realmChoices = computed(() =>
  (facets.data.value?.terms ?? []).filter((t) => t.dimensionKey === 'realm'),
)
function toggleRealm(slug: string) {
  const list = [...form.allowedRealms]
  const at = list.indexOf(slug)
  if (at >= 0) list.splice(at, 1)
  else list.push(slug)
  form.allowedRealms = list
}

const syncsWithItems = computed(
  () =>
    origin.value?.source === 'vault' &&
    !!connection.value &&
    itemsAvailable(connection.value) &&
    !items.isError.value,
)
const baselineDone = ref(false)
const baselinePending = computed(
  () =>
    origin.value?.source === 'vault' &&
    (connections.isPending.value || (syncsWithItems.value && !baselineDone.value)),
)
let syncId = 0
async function rebase(title: string) {
  const before = origin.value
  if (!before || !open.value) return
  const id = ++syncId
  const cid = props.circleId
  const fresh = await api.credential(cid, before.id).catch(() => null)
  if (id !== syncId || !open.value || origin.value?.id !== before.id) return
  baselineDone.value = true
  if (!fresh) return
  queryClient.setQueryData(['credential', cid, fresh.id], fresh)
  if (fresh.version !== origin.value.version) applyFresh(origin.value, fresh, title)
}
watch(
  () => [open.value, items.dataUpdatedAt.value, syncsWithItems.value] as const,
  ([isOpen, updatedAt, syncs]) => {
    if (isOpen && syncs && updatedAt && !saving.value)
      void rebase('凭据已在别处更新，表单中的改动已保留')
  },
)

// 新读到的一版合进表单（credentialForm.ts 的 mergeReloaded）
function applyFresh(before: ConsoleCredential, fresh: ConsoleCredential, title: string) {
  const merged = mergeReloaded(input(), before, fresh, () => nextKey++)
  mode.value = merged.input.mode
  Object.assign(form, merged.input.form)
  valueRows.value = merged.input.valueRows
  vaultRows.value = merged.input.vaultRows
  vaultValues.value = merged.input.vaultValues
  mergeNote.value = { title, conflicts: merged.conflicts }
}
// 新建的值写到哪里；去处用不了时提醒（服务端整次失败，不退回托管），读不到时不能新建
const {
  store,
  issue: storeIssue,
  failed: storeFailed,
} = useNewCredentialStore(
  toRef(props, 'circleId'),
  computed(() => open.value && isNew.value),
)

const itemFields = computed<string[]>(() => {
  if (target.value) return target.value.item.fields
  const itemId = origin.value?.vault?.itemId
  const found = items.data.value?.items.find((i) => i.id === itemId)
  const known = found?.fields ?? []
  const current = vaultRows.value.map((r) => r.itemField)
  return [...new Set([...known, ...current])]
})
const itemFieldItems = computed(() =>
  itemFields.value.map((f) => ({ label: itemFieldLabel(f), value: f })),
)
const unusedItemField = () =>
  itemFields.value.find((f) => !vaultRows.value.some((r) => r.itemField === f))

// 只列出自己是所有者的客户端：访问密钥按客户端所有者取凭据，别人的客户端取不到这些凭据。
// 已经限定了的照样列出来（已删掉的保留占位项），免得改别的地方时被悄悄去掉
const { me } = useSession()
const clientItems = computed(() => {
  const known = props.clients
    .filter((a) => a.ownerAccountId === me.data.value?.id || form.clientIds.includes(a.id))
    .map((a) => ({
      label:
        a.ownerAccountId === me.data.value?.id ? a.name : `${a.name}（非当前账号的客户端，不可用）`,
      value: a.id,
    }))
  const knownIds = new Set(props.clients.map((a) => a.id))
  const missing = form.clientIds
    .filter((id) => !knownIds.has(id))
    .map((id) => ({ label: '已删除的客户端', value: id }))
  return [...known, ...missing]
})

const input = (): CredentialFormInput => ({
  mode: mode.value,
  form,
  valueRows: valueRows.value,
  vaultRows: vaultRows.value,
  vaultValues: vaultValues.value,
})
const problem = computed(
  () =>
    (isNew.value ? storeBlocker({ store: store.value, failed: storeFailed.value }) : null) ??
    (baselinePending.value ? '正在读取最新版本' : null) ??
    formProblem(input()),
)

function removeValueRow(row: ValueRow) {
  if (row.existing) row.removed = !row.removed
  else valueRows.value.splice(valueRows.value.indexOf(row), 1)
}
function addVaultRow() {
  const field = unusedItemField()
  if (field) vaultRows.value.push(vaultRow('', field))
}

const saving = ref(false)
async function submit() {
  if (saving.value || problem.value) return
  saving.value = true
  failure.value = null
  failureDetail.value = null
  conflict.value = false
  orphan.value = null
  const cid = props.circleId
  const before = origin.value
  const creating = isNew.value
  try {
    let saved: ConsoleCredential
    let stored: string | null = null
    if (before) {
      saved = await api.updateCredential(cid, before.id, updateBody(input()))
    } else {
      const { storedIn, ...created } = await api.createCredential(cid, createBody(input()))
      saved = created
      if (creating) stored = storeName(storedIn)
    }
    clearValues()
    open.value = false
    toast.add({
      title: before ? '已保存' : `已新建凭据 ${saved.identifier}`,
      description: stored ? `写到：${stored}` : undefined,
      color: 'success',
    })
    emit('saved', saved, cid)
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : '保存失败'
    orphan.value = orphanVaultItem(err)
    const next = writeFailureNext(err, before ? 'update' : 'create')
    failureDetail.value = next.detail
    if (orphan.value) void queryClient.invalidateQueries({ queryKey: ['vault-items', cid] })
    if (before && next.reload) {
      conflict.value = true
      emit('conflict')
    }
  } finally {
    saving.value = false
  }
}

const reloading = ref(false)
async function reload() {
  const before = origin.value
  if (!before || reloading.value) return
  const cid = props.circleId
  const conn = connection.value
  reloading.value = true
  syncId++
  try {
    if (syncsWithItems.value && conn) {
      await queryClient.fetchQuery({
        queryKey: ['vault-items', cid, conn.id],
        queryFn: () => fetchVaultItems(queryClient, cid, conn.id),
        staleTime: 0,
      })
    }
    const fresh = await api.credential(cid, before.id)
    queryClient.setQueryData(['credential', cid, fresh.id], fresh)
    void invalidateInboxCounts(queryClient, cid)
    if (!open.value || origin.value?.id !== before.id) return
    applyFresh(origin.value, fresh, '已重新读取')
    failure.value = null
    failureDetail.value = null
    conflict.value = false
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : '读取失败'
  } finally {
    reloading.value = false
  }
}

const title = computed(() => {
  if (origin.value) return `修改凭据 ${origin.value.identifier}`
  return target.value ? `起标识：${target.value.item.name}` : '新建凭据'
})
const valuesHelp = computed(() => {
  if (editing.value) {
    return '已有字段的值留空表示不修改；值仅在提交时发送到服务端，此处不再显示。'
  }
  return store.value?.kind === 'vault'
    ? '值写进密码库的新条目，仅在提交时发送到服务端，此处不再显示。'
    : '值由 Kioku 使用主密钥加密保存，仅在提交时发送到服务端，此处不再显示。'
})
function openVault() {
  open.value = false
  emit('open-vault')
}
const orphanText = computed(() => (orphan.value ? orphanNotice(orphan.value) : null))
</script>

<template>
  <UModal
    :open="open"
    :title="title"
    :dismissible="!saving"
    :close="!saving"
    :ui="{ content: 'max-w-2xl' }"
    @update:open="(v) => (!v && saving) || (open = v)"
  >
    <template #body>
      <form id="credential-form" class="space-y-4" @submit.prevent="submit">
        <UFormField
          v-if="!editing"
          label="标识"
          help="创建后不可修改；记忆正文用 {{cred:<标识>#<字段>}} 引用。"
        >
          <UInput v-model="form.identifier" class="w-full font-mono" placeholder="file-server" />
        </UFormField>
        <UFormField label="名称">
          <UInput v-model="form.name" class="w-full" placeholder="文件服务器的管理账号" />
        </UFormField>
        <UFormField label="说明" help="填写用途与使用场景；内容会发送给 Agent，请勿写入凭据的值。">
          <UTextarea v-model="form.description" :rows="2" autoresize class="w-full" />
        </UFormField>

        <UFormField v-if="isNew" label="写到">
          <p class="store-line">
            <span :class="{ 'text-muted': !store }">{{ storeLabel(store, storeFailed) }}</span>
            <span v-if="store?.kind === 'vault'" class="text-muted">{{
              store.connection.email
            }}</span>
            <Hint>
              去处在「密码库」分页设置。设了去处时值写进去处集合的新条目，去处不可用时新建失败，不改由
              Kioku 托管。
            </Hint>
          </p>
          <p v-if="storeIssue" class="store-line text-warning">{{ storeIssue }}</p>
        </UFormField>

        <UFormField v-if="!isVault" label="字段" :help="valuesHelp">
          <div class="space-y-2">
            <div
              v-for="row in valueRows"
              :key="row.key"
              class="flex items-center gap-2"
              :class="row.removed ? 'opacity-50' : ''"
            >
              <UInput
                v-model="row.name"
                :disabled="row.existing"
                class="w-40 font-mono"
                placeholder="字段名"
                aria-label="字段名"
              />
              <UInput
                v-model="row.value"
                type="password"
                autocomplete="new-password"
                :disabled="row.removed"
                class="min-w-0 flex-1"
                :placeholder="row.existing ? '留空表示不修改' : '值'"
                :aria-label="`${row.name || '新字段'}的值`"
              />
              <UButton
                :icon="row.removed ? icons.undelete : icons.remove"
                color="neutral"
                variant="ghost"
                :aria-label="row.removed ? '保留此字段' : '删除此字段'"
                @click="removeValueRow(row)"
              />
            </div>
            <UButton
              :icon="icons.add"
              size="xs"
              color="neutral"
              variant="subtle"
              @click="valueRows.push(valueRow())"
            >
              添加字段
            </UButton>
          </div>
        </UFormField>

        <UFormField v-else label="字段对应">
          <template #help>
            左侧为占位符中的字段名，右侧为条目中的字段。
            <Hint>
              值保留在密码库中，每次取用时向密码库获取。TOTP 字段取用时给出当前的验证码。
            </Hint>
          </template>
          <div class="space-y-2">
            <div v-for="row in vaultRows" :key="row.key" class="flex items-center gap-2">
              <UInput
                v-model="row.name"
                class="w-40 font-mono"
                placeholder="字段名"
                aria-label="字段名"
              />
              <USelect
                v-model="row.itemField"
                :items="itemFieldItems"
                class="min-w-0 flex-1"
                :aria-label="`${row.name || '新字段'}对应的条目字段`"
              />
              <UButton
                :icon="icons.remove"
                color="neutral"
                variant="ghost"
                aria-label="删除此字段"
                @click="vaultRows.splice(vaultRows.indexOf(row), 1)"
              />
            </div>
            <UButton
              v-if="unusedItemField()"
              :icon="icons.add"
              size="xs"
              color="neutral"
              variant="subtle"
              @click="addVaultRow"
            >
              添加字段
            </UButton>
          </div>
        </UFormField>

        <UFormField v-if="vaultValues.length" label="改值">
          <template #help>
            值写回密码库的原条目，留空表示不修改。<Hint>
              只改填写了的字段，条目中的其他内容保留；修改密码时，旧密码进入条目的密码历史。TOTP
              密钥无法在此修改。
            </Hint>
          </template>
          <div class="space-y-2">
            <div v-for="row in vaultValues" :key="row.name" class="flex items-center gap-2">
              <span class="w-40 shrink-0 truncate font-mono text-sm" :title="row.name">{{
                row.name
              }}</span>
              <UInput
                v-model="row.value"
                type="password"
                autocomplete="new-password"
                :disabled="!writableVaultField(row)"
                class="min-w-0 flex-1"
                :placeholder="writableVaultField(row) ? '留空表示不修改' : 'TOTP 密钥无法修改'"
                :aria-label="`${row.name}的新值`"
              />
            </div>
          </div>
        </UFormField>

        <UFormField v-if="isNew" label="网址">
          <template #help>
            可选<Hint>{{ CREDENTIAL_URL_HINT }}</Hint>
          </template>
          <UInput
            v-model="form.url"
            class="w-full font-mono"
            placeholder="https://files.example.com"
            autocomplete="off"
          />
        </UFormField>

        <UFormField label="到期时间">
          <template #help>
            可选；到期前 {{ CREDENTIAL_EXPIRING_DAYS }} 天起进入待处理。<Hint>
              到期后照常可以取用，取用结果中注明已到期。
            </Hint>
          </template>
          <!-- 不到期是单独的状态：输入框填了一半时值也是空的，不能靠清空输入框来清除 -->
          <div v-if="form.expires.noExpiry" class="flex items-center gap-2">
            <span class="text-sm">不到期</span>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              @click="form.expires.noExpiry = false"
            >
              设置到期时间
            </UButton>
          </div>
          <div v-else class="flex items-center gap-2">
            <UInput
              v-model="form.expires.input"
              type="datetime-local"
              aria-label="到期时间"
              class="w-full sm:w-64"
              @input="(e: Event) => (form.expires.bad = expiresInputBad(e))"
              @keyup="(e: Event) => (form.expires.bad = expiresInputBad(e))"
              @blur="(e: Event) => (form.expires.bad = expiresInputBad(e))"
            />
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="form.expires = { noExpiry: true, input: '', bad: false }"
            >
              不到期
            </UButton>
          </div>
        </UFormField>

        <UFormField v-if="editing" :label="CREDENTIAL_ROTATION_NAME">
          <template #help>
            标记后进入待处理，值修改后自动清除。<Hint>例如怀疑值已泄露时标记。</Hint>
          </template>
          <USwitch v-model="form.needsRotation" :label="`标记为${CREDENTIAL_ROTATION_NAME}`" />
        </UFormField>

        <UFormField label="限定客户端">
          <template #help>
            仅选中客户端的访问密钥可以取用。
            <Hint>
              列表仅含当前账号所有的客户端。通过访问密钥新建的凭据默认限定给该客户端，只能在此处修改。
            </Hint>
          </template>
          <div class="space-y-2">
            <USwitch v-model="form.restrictClients" label="仅限部分客户端" />
            <USelect
              v-if="form.restrictClients"
              v-model="form.clientIds"
              :items="clientItems"
              multiple
              class="w-full"
              placeholder="选择客户端"
            />
          </div>
        </UFormField>

        <UFormField label="允许场域">
          <template #help>
            静态场域锁：开启后，不在所选场域内的访问密钥与会话上下文一律无法取用此凭据。
          </template>
          <div class="space-y-2">
            <USwitch v-model="form.restrictRealms" label="限定特定场域" />
            <template v-if="form.restrictRealms">
              <div v-if="realmChoices.length" class="flex flex-wrap gap-1.5">
                <UButton
                  v-for="t in realmChoices"
                  :key="t.slug"
                  size="xs"
                  :color="form.allowedRealms.includes(t.slug) ? 'primary' : 'neutral'"
                  :variant="form.allowedRealms.includes(t.slug) ? 'solid' : 'outline'"
                  @click="toggleRealm(t.slug)"
                >
                  {{ t.label }}（{{ t.slug }}）
                </UButton>
              </div>
              <UInputTags
                v-model="form.allowedRealms"
                class="w-full font-mono"
                placeholder="输入场域条件项标识（如 work、home）"
              />
            </template>
          </div>
        </UFormField>

        <NoteLine
          v-if="mergeNote && (mergeNote.conflicts.length || mergeNote.title !== '已重新读取')"
          tone="warning"
        >
          {{ mergeNote.title }}
          <template v-if="mergeNote.conflicts.length" #detail
            >需要核对：{{ mergeNote.conflicts.join('；') }}</template
          >
        </NoteLine>
        <!-- 留下的条目与失败的原因都要显示：只看到条目的提示，不知道为什么失败，再提交又多建一个 -->
        <NoteLine v-if="orphanText" tone="warning">
          {{ orphanText.title }}
          <template #detail>{{ orphanText.detail }}</template>
          <template #actions>
            <UButton size="sm" color="primary" variant="outline" @click="openVault">
              查看密码库
            </UButton>
          </template>
        </NoteLine>
        <NoteLine v-if="failure" tone="error">
          {{ failure }}
          <template v-if="conflict || failureDetail" #detail>{{
            conflict ? '重新读取后再保存，表单中的改动保留。' : failureDetail
          }}</template>
          <template v-if="conflict" #actions>
            <UButton
              size="sm"
              color="primary"
              variant="outline"
              :loading="reloading"
              @click="reload"
            >
              重新读取
            </UButton>
          </template>
        </NoteLine>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <span v-if="problem" class="mr-auto text-sm text-muted">{{ problem }}</span>
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false"
          >取消</UButton
        >
        <UButton
          type="submit"
          form="credential-form"
          :loading="saving"
          :disabled="!!problem || conflict"
        >
          {{ editing ? '保存' : target ? '起标识' : '新建' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.store-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
