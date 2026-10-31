<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CREDENTIAL_NAME_PATTERN,
  MAX_CREDENTIAL_FIELDS,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  type AppInfo,
  type ConsoleCredential,
  type CredentialProvider,
  type CredentialSource,
  type CredentialSourceUpdate,
} from '@kioku/contracts'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { providerKindLabels } from '../labels'
import Hint from './Hint.vue'

// 新建与修改共用。修改时打开的那一刻记下这一版：提交用它的版本号，期间别处改过就返回冲突
const props = defineProps<{
  spaceId: string
  credential: ConsoleCredential | null
  providers: CredentialProvider[]
  apps: AppInfo[]
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
interface ExternalRow {
  key: number
  name: string
  sourceField: string
}

let nextKey = 0
const origin = ref<ConsoleCredential | null>(null)
const form = reactive({
  identifier: '',
  name: '',
  description: '',
  kind: 'hosted' as CredentialSource,
  providerId: undefined as string | undefined,
  location: '',
  restrict: false,
  appIds: [] as string[],
})
const hostedRows = ref<HostedRow[]>([])
const externalRows = ref<ExternalRow[]>([])

const hostedRow = (name = '', existing = false): HostedRow => ({
  key: nextKey++,
  name,
  value: '',
  existing,
  removed: false,
})
const externalRow = (name = '', sourceField = ''): ExternalRow => ({
  key: nextKey++,
  name,
  sourceField,
})

watch(open, (isOpen) => {
  if (!isOpen) return
  const c = props.credential
  origin.value = c
  Object.assign(form, {
    identifier: c?.identifier ?? '',
    name: c?.name ?? '',
    description: c?.description ?? '',
    kind: c?.source ?? 'hosted',
    // 新建时只有一个凭据源就直接选上它
    providerId: c
      ? c.provider && !c.provider.deleted
        ? c.provider.id
        : undefined
      : props.providers.length === 1
        ? props.providers[0]!.id
        : undefined,
    location: c?.location ?? '',
    restrict: c?.appIds != null,
    appIds: c?.appIds ?? [],
  })
  hostedRows.value =
    c?.source === 'hosted'
      ? c.fields.map((f) => hostedRow(f.name, true))
      : [hostedRow('username'), hostedRow('password')]
  externalRows.value =
    c?.source === 'external'
      ? c.fields.map((f) => externalRow(f.name, f.sourceField ?? ''))
      : [externalRow('password', 'password')]
})

const editing = computed(() => origin.value !== null)
// 修改时只改来源的类型（托管 ↔ 外部）也算：从外部改成托管要填全部字段的值
const switchingToHosted = computed(
  () => editing.value && origin.value?.source !== 'hosted' && form.kind === 'hosted',
)
const providerItems = computed(() =>
  props.providers.map((p) => ({
    label: `${p.name}（${providerKindLabels[p.kind]}）`,
    value: p.id,
  })),
)
// 只列出自己是主人的应用：Key 按应用主人取凭据，别人的应用的 Key 用不了你的凭据。
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
const sourceItems = computed(() => [
  { label: 'Kioku 托管', description: '值由 Kioku 使用主密钥加密保存', value: 'hosted' },
  {
    label: '外部凭据源',
    description: props.providers.length
      ? '值保留在密码管理器中，Kioku 仅记录条目位置，由 Agent 在本机获取'
      : '请先在「凭据源」中添加密码管理器',
    value: 'external',
    disabled: !props.providers.length,
  },
])

const validName = (name: string) => CREDENTIAL_NAME_PATTERN.test(name)
const liveHosted = computed(() => hostedRows.value.filter((r) => !r.removed))
// 提交前在界面上能看出来的问题；服务端照样会检查
const problem = computed<string | null>(() => {
  if (!editing.value && !validName(form.identifier)) {
    return '标识只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  }
  if (!form.name.trim()) return '名称不能为空'
  const rows = form.kind === 'hosted' ? liveHosted.value : externalRows.value
  if (!rows.length) return '至少需要一个字段'
  // 修改托管的只发改了的字段，合并之后的总数要在这里看
  if (rows.length > MAX_CREDENTIAL_FIELDS) return `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`
  const names = rows.map((r) => r.name)
  if (names.some((n) => !validName(n)))
    return '字段名只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  if (new Set(names).size !== names.length) return '字段名不能重复'
  if (form.kind === 'hosted') {
    const needsValue = liveHosted.value.filter((r) => !r.existing || switchingToHosted.value)
    if (needsValue.some((r) => !r.value)) return '请填写新字段的值'
  } else {
    if (!form.providerId) return '请选择凭据源'
    if (!form.location.trim()) return '请填写条目位置'
    if (externalRows.value.some((r) => !r.sourceField.trim())) return '请填写每个字段对应的条目字段'
  }
  if (form.restrict && !form.appIds.length) return '限定应用时至少选择一个'
  // 其余规则（长度、条目位置里不能有的字符等）直接用接口的定义检查，提示与服务端一致
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

// 修改时要发的来源：没改就不发
function sourceChange(): CredentialSourceUpdate | undefined {
  const before = origin.value
  if (form.kind === 'hosted') {
    const values: Record<string, string | null> = {}
    for (const row of hostedRows.value) {
      if (row.existing && row.removed && !switchingToHosted.value) values[row.name] = null
      else if (!row.removed && row.value) values[row.name] = row.value
    }
    if (!switchingToHosted.value && !Object.keys(values).length) return undefined
    return { kind: 'hosted', values }
  }
  const fields = externalFields()
  const same =
    before?.source === 'external' &&
    before.provider?.id === form.providerId &&
    before.location === form.location.trim() &&
    JSON.stringify(before.fields) === JSON.stringify(fields)
  return same
    ? undefined
    : { kind: 'external', providerId: form.providerId!, location: form.location.trim(), fields }
}

const saving = ref(false)
const externalFields = () =>
  externalRows.value.map((r) => ({ name: r.name, sourceField: r.sourceField.trim() }))

function createBody(): CreateCredentialRequest {
  return {
    identifier: form.identifier,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    source:
      form.kind === 'hosted'
        ? {
            kind: 'hosted',
            values: Object.fromEntries(liveHosted.value.map((r) => [r.name, r.value])),
          }
        : {
            kind: 'external',
            providerId: form.providerId ?? '',
            location: form.location.trim(),
            fields: externalFields(),
          },
  }
}

function updateBody(): UpdateCredentialRequest {
  const source = sourceChange()
  return {
    expectedVersion: origin.value?.version ?? 0,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    ...(source ? { source } : {}),
  }
}

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

// 关掉时清掉填过的值
watch(open, (isOpen) => {
  if (!isOpen) for (const row of hostedRows.value) row.value = ''
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="editing ? `修改凭据 ${origin?.identifier}` : '新建凭据'"
    :ui="{ content: 'max-w-2xl' }"
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
        <UFormField label="来源">
          <URadioGroup v-model="form.kind" :items="sourceItems" />
        </UFormField>

        <template v-if="form.kind === 'hosted'">
          <UFormField
            label="字段"
            :help="
              editing && !switchingToHosted
                ? '已有字段的值留空表示不修改；值仅在提交时发送到服务端，此处不再显示。'
                : '值仅在提交时发送到服务端，此处不再显示。'
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
                  :disabled="row.existing && !switchingToHosted"
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
                  :placeholder="row.existing && !switchingToHosted ? '留空表示不修改' : '值'"
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
        </template>

        <template v-else>
          <UFormField label="凭据源">
            <USelect v-model="form.providerId" :items="providerItems" class="w-full" />
          </UFormField>
          <UFormField
            label="条目位置"
            help="密码管理器中的条目名、ID 或路径，例如 file-server admin"
          >
            <UInput v-model="form.location" class="w-full" />
          </UFormField>
          <UFormField label="字段对应" help="左侧为占位符中的字段名，右侧为条目中对应的字段">
            <div class="space-y-2">
              <div v-for="row in externalRows" :key="row.key" class="flex items-center gap-2">
                <UInput
                  v-model="row.name"
                  class="w-40 font-mono"
                  placeholder="字段名"
                  aria-label="字段名"
                />
                <UInput
                  v-model="row.sourceField"
                  class="min-w-0 flex-1"
                  placeholder="条目字段，例如 password"
                  :aria-label="`${row.name || '新字段'}对应的条目字段`"
                />
                <UButton
                  :icon="icons.remove"
                  color="neutral"
                  variant="ghost"
                  aria-label="删除此字段"
                  @click="externalRows.splice(externalRows.indexOf(row), 1)"
                />
              </div>
              <UButton
                :icon="icons.add"
                size="xs"
                color="neutral"
                variant="subtle"
                @click="externalRows.push(externalRow())"
              >
                添加字段
              </UButton>
            </div>
          </UFormField>
        </template>

        <UFormField label="限定应用">
          <template #help>
            仅选中应用的 Key 可以取用。
            <Hint>
              列表仅含当前账号所有的应用。通过 Key 新建的凭据默认限定给该应用，只能在此处修改。
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
        <span v-if="problem" class="mr-auto text-xs text-muted">{{ problem }}</span>
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="credential-form" :loading="saving" :disabled="!!problem">
          {{ editing ? '保存' : '新建' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
