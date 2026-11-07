<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CREDENTIAL_EXPIRING_DAYS,
  CREDENTIAL_ROTATION_NAME,
  type AppInfo,
  type ConsoleCredential,
  type OrphanVaultItem,
  type VaultItemSummary,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import {
  createBody,
  formProblem,
  updateBody,
  type CredentialFormInput,
  type CredentialFormMode,
  type ValueRow,
  type VaultRow,
  type VaultValueRow,
} from '../credentialForm'
import { icons } from '../icons'
import { invalidateInboxCounts } from '../inbox'
import {
  CREDENTIAL_URL_HINT,
  destinationProblem,
  expiresInput,
  itemFieldLabel,
  itemsAvailable,
  newCredentialStore,
  orphanNotice,
  orphanVaultItem,
  storedInName,
  storeName,
  vaultCredentialDraft,
  writableVaultField,
} from '../vault'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'

// 新建凭据、给密码库条目起标识、修改两种凭据共用。修改时打开的那一刻记下这一版：
// 提交用它的版本号，期间别处改过就返回冲突。来源不能改：托管的改值；密码库的改字段对应，值写回原条目。
// 新建的值写到哪里由去处决定（设了去处写进那个集合，没有时由 Kioku 托管），表单里只说明，不让选
const props = defineProps<{
  spaceId: string
  credential: ConsoleCredential | null
  // 起标识时的条目与它所在的连接；新建与修改时为 null
  vaultItem: { connectionId: string; item: VaultItemSummary } | null
  apps: AppInfo[]
  // 已有的标识，起标识时建议的标识避开它们
  identifiers: readonly string[]
}>()
const open = defineModel<boolean>('open', { required: true })
// 事件带上提交时的空间：保存期间切换了空间，页面不能把结果写进新空间
const emit = defineEmits<{
  saved: [credential: ConsoleCredential, spaceId: string]
  conflict: []
  // 写进了密码库、凭据却没建成：页面切到「密码库」分页给条目起标识
  'open-vault': []
}>()
const toast = useToast()
const queryClient = useQueryClient()

let nextKey = 0
const mode = ref<CredentialFormMode>({ kind: 'new' })
const form = reactive({
  identifier: '',
  name: '',
  description: '',
  restrict: false,
  appIds: [] as string[],
  url: '',
  expires: '',
  needsRotation: false,
})
const valueRows = ref<ValueRow[]>([])
const vaultRows = ref<VaultRow[]>([])
const vaultValues = ref<VaultValueRow[]>([])
// 提交失败的说明；409 时可以重新读取；写进了密码库却没建成凭据时留下的条目
const failure = ref<string | null>(null)
const conflict = ref(false)
const orphan = ref<OrphanVaultItem | null>(null)

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

// 按凭据或条目填好表单。keep：重新读取之后，同名字段里已经填的值留着
function fill(c: ConsoleCredential | null, keep?: Map<string, string>) {
  const item = c ? null : props.vaultItem
  const draft = item ? vaultCredentialDraft(item.item, props.identifiers) : null
  mode.value = c
    ? { kind: 'edit', origin: c }
    : item
      ? { kind: 'name-item', ...item }
      : { kind: 'new' }
  Object.assign(form, {
    identifier: draft?.identifier ?? '',
    name: c?.name ?? draft?.name ?? '',
    description: c?.description ?? '',
    restrict: c?.appIds != null,
    appIds: c?.appIds ?? [],
    url: '',
    expires: expiresInput(c?.expiresAt ?? null),
    needsRotation: c?.rotationRequestedAt != null,
  })
  valueRows.value =
    c?.source === 'hosted'
      ? c.fields.map((f) => valueRow(f.name, true))
      : [valueRow('username'), valueRow('password')]
  // 起标识时按条目里的字段预填，和服务端没给字段对应时推出的一样
  vaultRows.value = c
    ? c.fields.flatMap((f) => (f.itemField ? [vaultRow(f.name, f.itemField)] : []))
    : (draft?.fields ?? []).map((f) => vaultRow(f.name, f.itemField!))
  vaultValues.value =
    c?.source === 'vault'
      ? c.fields.flatMap((f) =>
          f.itemField ? [{ name: f.name, itemField: f.itemField, value: '' }] : [],
        )
      : []
  if (keep) {
    for (const row of [...valueRows.value, ...vaultValues.value]) {
      row.value = keep.get(row.name) ?? ''
    }
  }
  failure.value = null
  conflict.value = false
  orphan.value = null
}

watch(open, (isOpen) => {
  // 关掉时清掉填过的值
  if (!isOpen) clearValues()
  else fill(props.credential)
})

// 去处与可选的条目字段都从连接取：和凭据页、详情同一个查询，只有可用的连接列得出条目
const editingConnection = computed(() => origin.value?.vault?.connectionId ?? null)
const connections = useQuery({
  queryKey: computed(() => ['vault-connections', props.spaceId] as const),
  queryFn: ({ queryKey: [, sid] }) => api.vaultConnections(sid),
  enabled: computed(() => open.value && (editingConnection.value !== null || isNew.value)),
})
const connection = computed(
  () => connections.data.value?.items.find((x) => x.id === editingConnection.value) ?? null,
)
const items = useQuery({
  queryKey: computed(() => ['vault-items', props.spaceId, editingConnection.value] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.vaultItems(sid, id!),
  enabled: computed(() => open.value && !!connection.value && itemsAvailable(connection.value)),
})
// 新建的值写到哪里；去处用不了时提醒（服务端整次失败，不退回托管）
const store = computed(() => newCredentialStore(connections.data.value?.items))
const storeIssue = computed(() =>
  store.value?.kind === 'vault' ? destinationProblem(store.value.connection) : null,
)

const itemFields = computed<string[]>(() => {
  if (target.value) return target.value.item.fields
  const itemId = origin.value?.vault?.itemId
  const found = items.data.value?.items.find((i) => i.id === itemId)
  // 条目读不到时（连接不可用、条目不可用、列表读取失败）只能在已有的对应里改
  const known = found?.fields ?? []
  const current = vaultRows.value.map((r) => r.itemField)
  return [...new Set([...known, ...current])]
})
const itemFieldItems = computed(() =>
  itemFields.value.map((f) => ({ label: itemFieldLabel(f), value: f })),
)
const unusedItemField = () =>
  itemFields.value.find((f) => !vaultRows.value.some((r) => r.itemField === f))

// 只列出自己是所有者的应用：访问密钥按应用所有者取凭据，别人的应用的访问密钥取不到这些凭据。
// 已经限定了的照样列出来，免得改别的地方时被悄悄去掉
const { me } = useSession()
const appItems = computed(() =>
  props.apps
    .filter((a) => a.ownerAccountId === me.data.value?.id || form.appIds.includes(a.id))
    .map((a) => ({
      label:
        a.ownerAccountId === me.data.value?.id ? a.name : `${a.name}（非当前账号的应用，不可用）`,
      value: a.id,
    })),
)

const input = (): CredentialFormInput => ({
  mode: mode.value,
  form,
  valueRows: valueRows.value,
  vaultRows: vaultRows.value,
  vaultValues: vaultValues.value,
})
const problem = computed(() => formProblem(input()))

// 已有的字段标记删除（再点一次取消），新加的直接去掉
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
  conflict.value = false
  orphan.value = null
  const spaceId = props.spaceId
  const before = origin.value
  const creating = isNew.value
  try {
    let saved: ConsoleCredential
    let stored: string | null = null
    if (before) {
      saved = await api.updateCredential(spaceId, before.id, updateBody(input()))
    } else {
      const { storedIn, ...created } = await api.createCredential(spaceId, createBody(input()))
      saved = created
      if (creating) stored = storedInName(storedIn)
    }
    // 填过的值不留在页面里
    clearValues()
    open.value = false
    toast.add({
      title: before ? '已保存' : `已新建凭据 ${saved.identifier}`,
      description: stored ? `写到：${stored}` : undefined,
      color: 'success',
    })
    emit('saved', saved, spaceId)
  } catch (err) {
    failure.value = err instanceof ApiError ? err.message : '保存失败'
    orphan.value = orphanVaultItem(err)
    // 留下的条目出现在条目列表里，可以起标识
    if (orphan.value) void queryClient.invalidateQueries({ queryKey: ['vault-items', spaceId] })
    // 版本冲突、条目在别处改过：重新读取，看过新的那一版再改
    if (err instanceof ApiError && err.status === 409 && before) {
      conflict.value = true
      emit('conflict')
    }
  } finally {
    saving.value = false
  }
}

// 重新读取：换成最新的一版，已经填的值按字段名留着；条目的修改时间也变了，条目列表一起重读
const reloading = ref(false)
async function reload() {
  const before = origin.value
  if (!before || reloading.value) return
  const spaceId = props.spaceId
  reloading.value = true
  try {
    const fresh = await api.credential(spaceId, before.id)
    queryClient.setQueryData(['credential', spaceId, fresh.id], fresh)
    void queryClient.invalidateQueries({ queryKey: ['vault-items', spaceId] })
    void invalidateInboxCounts(queryClient, spaceId)
    if (!open.value || origin.value?.id !== before.id) return
    const keep = new Map(
      [...valueRows.value, ...vaultValues.value].map((r) => [r.name, r.value] as const),
    )
    fill(fresh, keep)
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
  <UModal v-model:open="open" :title="title" :ui="{ content: 'max-w-2xl' }">
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
            <span v-if="store">{{ storeName(store) }}</span>
            <span v-else-if="connections.isError.value" class="text-muted">去处读取失败</span>
            <span v-else class="text-muted">…</span>
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
            可选。<Hint>{{ CREDENTIAL_URL_HINT }}</Hint>
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
              到期后照常可以取用，取用结果中注明已到期。留空表示不到期。
            </Hint>
          </template>
          <div class="flex items-center gap-2">
            <UInput
              v-model="form.expires"
              type="datetime-local"
              aria-label="到期时间"
              class="w-full sm:w-64"
            />
            <UButton
              v-if="form.expires"
              size="xs"
              color="neutral"
              variant="ghost"
              @click="form.expires = ''"
            >
              清除
            </UButton>
          </div>
        </UFormField>

        <UFormField v-if="editing" :label="CREDENTIAL_ROTATION_NAME">
          <template #help>
            标记后进入待处理，值修改后自动清除。<Hint>例如怀疑值已泄露时标记。</Hint>
          </template>
          <USwitch v-model="form.needsRotation" :label="`标记为${CREDENTIAL_ROTATION_NAME}`" />
        </UFormField>

        <UFormField label="限定应用">
          <template #help>
            仅选中应用的访问密钥可以取用。
            <Hint>
              列表仅含当前账号所有的应用。通过访问密钥新建的凭据默认限定给该应用，只能在此处修改。
            </Hint>
          </template>
          <div class="space-y-2">
            <USwitch v-model="form.restrict" label="仅限部分应用" />
            <USelect
              v-if="form.restrict"
              v-model="form.appIds"
              :items="appItems"
              multiple
              class="w-full"
              placeholder="选择应用"
            />
          </div>
        </UFormField>

        <NoteLine v-if="orphanText" tone="warning">
          {{ orphanText.title }}
          <template #detail>{{ orphanText.detail }}</template>
          <template #actions>
            <UButton size="sm" color="primary" variant="outline" @click="openVault">
              查看密码库
            </UButton>
          </template>
        </NoteLine>
        <NoteLine v-else-if="failure" tone="error">
          {{ failure }}
          <template v-if="conflict" #detail>重新读取后再修改，已填写的值保留。</template>
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
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
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
