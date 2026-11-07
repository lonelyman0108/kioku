<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CREDENTIAL_NAME_PATTERN,
  MAX_CREDENTIAL_FIELDS,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  type AppInfo,
  type ConsoleCredential,
  type VaultItemSummary,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { itemFieldLabel, vaultCredentialDraft } from '../vault'
import Hint from './Hint.vue'

// 新建托管凭据、给密码库条目起标识、修改两种凭据共用。修改时打开的那一刻记下这一版：
// 提交用它的版本号，期间别处改过就返回冲突。来源不能改：托管的改值，密码库的改字段对应
const props = defineProps<{
  spaceId: string
  credential: ConsoleCredential | null
  // 起标识时的条目与它所在的连接；新建托管凭据与修改时为 null
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
}>()
const toast = useToast()

// 托管的一行：existing 表示修改时已有的字段，值留空就是不改，removed 表示删掉它
interface HostedRow {
  key: number
  name: string
  value: string
  existing: boolean
  removed: boolean
}
// 密码库的一行：凭据里的字段名对应条目里的哪个字段
interface VaultRow {
  key: number
  name: string
  itemField: string
}

let nextKey = 0
const origin = ref<ConsoleCredential | null>(null)
const target = ref<{ connectionId: string; item: VaultItemSummary } | null>(null)
const form = reactive({
  identifier: '',
  name: '',
  description: '',
  restrict: false,
  appIds: [] as string[],
})
const hostedRows = ref<HostedRow[]>([])
const vaultRows = ref<VaultRow[]>([])

const hostedRow = (name = '', existing = false): HostedRow => ({
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

const editing = computed(() => origin.value !== null)
const isVault = computed(() =>
  origin.value ? origin.value.source === 'vault' : target.value !== null,
)

watch(open, (isOpen) => {
  if (!isOpen) {
    // 关掉时清掉填过的值
    for (const row of hostedRows.value) row.value = ''
    return
  }
  const c = props.credential
  const item = c ? null : props.vaultItem
  const draft = item ? vaultCredentialDraft(item.item, props.identifiers) : null
  origin.value = c
  target.value = item
  Object.assign(form, {
    identifier: draft?.identifier ?? '',
    name: c?.name ?? draft?.name ?? '',
    description: c?.description ?? '',
    restrict: c?.appIds != null,
    appIds: c?.appIds ?? [],
  })
  hostedRows.value =
    c?.source === 'hosted'
      ? c.fields.map((f) => hostedRow(f.name, true))
      : [hostedRow('username'), hostedRow('password')]
  // 起标识时按条目里的字段预填，和服务端没给字段对应时推出的一样
  vaultRows.value = c
    ? c.fields.flatMap((f) => (f.itemField ? [vaultRow(f.name, f.itemField)] : []))
    : (draft?.fields ?? []).map((f) => vaultRow(f.name, f.itemField!))
})

// 修改密码库凭据时，可选的条目字段从连接的条目列表里取；和凭据页、详情同一个查询
const editingConnection = computed(() => origin.value?.vault?.connectionId ?? null)
const items = useQuery({
  queryKey: computed(() => ['vault-items', props.spaceId, editingConnection.value] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.vaultItems(sid, id!),
  enabled: computed(() => open.value && editingConnection.value !== null),
})
const itemFields = computed<string[]>(() => {
  if (target.value) return target.value.item.fields
  const itemId = origin.value?.vault?.itemId
  const found = items.data.value?.items.find((i) => i.id === itemId)
  // 条目读不到时（不可用、列表读取失败）只能在已有的对应里改
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

const validName = (name: string) => CREDENTIAL_NAME_PATTERN.test(name)
const liveHosted = computed(() => hostedRows.value.filter((r) => !r.removed))
// 提交前在界面上能看出来的问题；服务端照样会检查
const problem = computed<string | null>(() => {
  if (!editing.value && !validName(form.identifier)) {
    return '标识只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  }
  if (!form.name.trim()) return '名称不能为空'
  const rows = isVault.value ? vaultRows.value : liveHosted.value
  if (!rows.length) return '至少需要一个字段'
  // 修改托管的只发改了的字段，合并之后的总数要在这里看
  if (rows.length > MAX_CREDENTIAL_FIELDS) return `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`
  const names = rows.map((r) => r.name)
  if (names.some((n) => !validName(n)))
    return '字段名只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  if (new Set(names).size !== names.length) return '字段名不能重复'
  if (!isVault.value && liveHosted.value.some((r) => !r.existing && !r.value)) {
    return '请填写新字段的值'
  }
  if (form.restrict && !form.appIds.length) return '限定应用时至少选择一个'
  // 其余规则（长度等）直接用接口的定义检查，提示与服务端一致
  const result = editing.value
    ? UpdateCredentialRequest.safeParse(updateBody())
    : CreateCredentialRequest.safeParse(createBody())
  return result.success ? null : (result.error.issues[0]?.message ?? '填写内容有误')
})

// 已有的字段标记删除（再点一次取消），新加的直接去掉
function removeHostedRow(row: HostedRow) {
  if (row.existing) row.removed = !row.removed
  else hostedRows.value.splice(hostedRows.value.indexOf(row), 1)
}
function addVaultRow() {
  const field = unusedItemField()
  if (field) vaultRows.value.push(vaultRow('', field))
}

const vaultFields = () => vaultRows.value.map((r) => ({ name: r.name, itemField: r.itemField }))

// 修改托管的值：只发改了的字段，删掉的为 null
function hostedChanges(): Record<string, string | null> | undefined {
  const values: Record<string, string | null> = {}
  for (const row of hostedRows.value) {
    if (row.existing && row.removed) values[row.name] = null
    else if (!row.removed && row.value) values[row.name] = row.value
  }
  return Object.keys(values).length ? values : undefined
}
// 修改密码库的字段对应：整个替换，没改就不发
function vaultChanges() {
  const fields = vaultFields()
  const before = (origin.value?.fields ?? []).map((f) => ({ name: f.name, itemField: f.itemField }))
  return JSON.stringify(before) === JSON.stringify(fields) ? undefined : fields
}

function createBody(): CreateCredentialRequest {
  const t = target.value
  return {
    identifier: form.identifier,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    source: t
      ? { kind: 'vault', connectionId: t.connectionId, itemId: t.item.id, fields: vaultFields() }
      : {
          kind: 'hosted',
          values: Object.fromEntries(liveHosted.value.map((r) => [r.name, r.value])),
        },
  }
}

function updateBody(): UpdateCredentialRequest {
  const values = isVault.value ? undefined : hostedChanges()
  const fields = isVault.value ? vaultChanges() : undefined
  return {
    expectedVersion: origin.value?.version ?? 0,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    ...(values ? { values } : {}),
    ...(fields ? { fields } : {}),
  }
}

const saving = ref(false)
async function submit() {
  if (saving.value || problem.value) return
  saving.value = true
  const spaceId = props.spaceId
  try {
    const before = origin.value
    const saved = before
      ? await api.updateCredential(spaceId, before.id, updateBody())
      : await api.createCredential(spaceId, createBody())
    // 填过的值不留在页面里
    for (const row of hostedRows.value) row.value = ''
    open.value = false
    toast.add({ title: before ? '已保存' : `已新建凭据 ${saved.identifier}`, color: 'success' })
    emit('saved', saved, spaceId)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
    // 版本冲突：期间别处改过，关掉重开看过新的那一版再改
    if (err instanceof ApiError && err.status === 409 && origin.value) {
      open.value = false
      emit('conflict')
    }
  } finally {
    saving.value = false
  }
}

const title = computed(() => {
  if (origin.value) return `修改凭据 ${origin.value.identifier}`
  return target.value ? `起标识：${target.value.item.name}` : '新建凭据'
})
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

        <UFormField
          v-if="!isVault"
          label="字段"
          :help="
            editing
              ? '已有字段的值留空表示不修改；值仅在提交时发送到服务端，此处不再显示。'
              : '值由 Kioku 使用主密钥加密保存，仅在提交时发送到服务端，此处不再显示。'
          "
        >
          <div class="space-y-2">
            <div
              v-for="row in hostedRows"
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
                @click="removeHostedRow(row)"
              />
            </div>
            <UButton
              :icon="icons.add"
              size="xs"
              color="neutral"
              variant="subtle"
              @click="hostedRows.push(hostedRow())"
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
      </form>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2">
        <span v-if="problem" class="mr-auto text-sm text-muted">{{ problem }}</span>
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="credential-form" :loading="saving" :disabled="!!problem">
          {{ editing ? '保存' : '新建' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
