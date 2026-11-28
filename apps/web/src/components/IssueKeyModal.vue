<script setup lang="ts">
import {
  BUILTIN_ENVS,
  KEY_NAME_MAX,
  KeyName,
  normalizeSlugList,
  SceneSlug,
  type ApiKeyView,
  type IssuedApiKeyResponse,
  type RuntimeFamily,
} from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import { countMatchingCredentials } from '../keyFilters'
import { envDisplayName } from '../labels'
import { RUNTIME_OPTIONS } from '../runtimes'
import { formatRelative } from '../time'
import SegmentedChoice from './SegmentedChoice.vue'
import NoteLine from './ui/NoteLine.vue'

type RealmMode = 'all' | 'scoped' | 'generic'

const props = withDefaults(
  defineProps<{
    editing: ApiKeyView | null
    knownRealms?: readonly string[]
  }>(),
  { knownRealms: () => [] },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  saved: [item: ApiKeyView]
  requestRotate: [item: ApiKeyView]
  requestRevoke: [item: ApiKeyView]
}>()

const copy = useCopy()

const form = reactive({
  name: '',
  runtimeFamily: 'claudecode' as RuntimeFamily,
  envs: [] as string[],
  realmMode: 'all' as RealmMode,
  allowedRealms: [] as string[],
  focusRealms: [] as string[],
  canWrite: true,
  canResolveCredentials: false,
})
const customEnv = ref('')
const customRealm = ref('')
const customFocusRealm = ref('')
const saving = ref(false)
const error = ref<string | null>(null)
const issued = ref<IssuedApiKeyResponse | null>(null)

const realmModeOptions = [
  { value: 'all' as const, label: '不限场域' },
  { value: 'scoped' as const, label: '限定场域' },
  { value: 'generic' as const, label: '仅通用' },
]

// 仅在开启「允许解析托管凭据」且抽屉打开时共享凭据元数据缓存，计算一行统计
const credentialsQuery = useQuery({
  queryKey: ['credentials'] as const,
  queryFn: () => api.credentials(),
  enabled: computed(() => open.value && !issued.value && form.canResolveCredentials),
  staleTime: 60_000,
})

function effectiveAllowedRealms(): string[] | null {
  if (form.realmMode === 'all') return null
  if (form.realmMode === 'generic') return []
  return normalizeSlugList(form.allowedRealms)
}

const matchingCredentialCount = computed(() => {
  const items = credentialsQuery.data.value?.items
  if (!items) return null
  return countMatchingCredentials(
    {
      canResolveCredentials: form.canResolveCredentials,
      allowedRealms: effectiveAllowedRealms(),
    },
    items,
  )
})

const realmChoices = computed(() =>
  normalizeSlugList(['work', 'personal', ...props.knownRealms, ...form.allowedRealms]),
)

const focusRealmOptions = computed(() =>
  normalizeSlugList([
    'work',
    'personal',
    ...props.knownRealms,
    ...form.allowedRealms,
    ...form.focusRealms,
  ]),
)

const outOfScopeFocusRealms = computed(() => {
  if (form.realmMode === 'all') return []
  const allowed = form.realmMode === 'generic' ? [] : form.allowedRealms
  return form.focusRealms.filter((r) => !allowed.includes(r))
})

watch(open, (visible) => {
  if (!visible) return
  issued.value = null
  error.value = null
  customEnv.value = ''
  customRealm.value = ''
  customFocusRealm.value = ''
  if (props.editing) {
    form.name = props.editing.name
    form.runtimeFamily = props.editing.runtimeFamily
    form.envs = [...props.editing.envs]
    form.realmMode =
      props.editing.allowedRealms === null
        ? 'all'
        : props.editing.allowedRealms.length === 0
          ? 'generic'
          : 'scoped'
    form.allowedRealms = [...(props.editing.allowedRealms ?? [])]
    form.focusRealms = [...(props.editing.focusRealms ?? [])]
    form.canWrite = props.editing.canWrite
    form.canResolveCredentials = props.editing.canResolveCredentials
  } else {
    form.name = ''
    form.runtimeFamily = 'claudecode'
    form.envs = []
    form.realmMode = 'all'
    form.allowedRealms = []
    form.focusRealms = []
    form.canWrite = true
    form.canResolveCredentials = false
  }
})

const sameList = (
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
) =>
  (a === null || a === undefined) === (b === null || b === undefined) &&
  normalizeSlugList(a ?? []).join('\n') === normalizeSlugList(b ?? []).join('\n')

const isDirty = computed(() => {
  if (!props.editing) return true
  const nextAllowed = effectiveAllowedRealms()
  const nextFocus = form.focusRealms.length ? normalizeSlugList(form.focusRealms) : null
  const origFocus = props.editing.focusRealms?.length
    ? normalizeSlugList(props.editing.focusRealms)
    : null
  return (
    form.name.trim() !== props.editing.name ||
    form.runtimeFamily !== props.editing.runtimeFamily ||
    !sameList(form.envs, props.editing.envs) ||
    !sameList(nextAllowed, props.editing.allowedRealms) ||
    !sameList(nextFocus, origFocus) ||
    form.canWrite !== props.editing.canWrite ||
    form.canResolveCredentials !== props.editing.canResolveCredentials
  )
})

function toggleEnv(slug: string) {
  form.envs = form.envs.includes(slug)
    ? form.envs.filter((v) => v !== slug)
    : normalizeSlugList([...form.envs, slug])
}

function addEnv() {
  const parsed = SceneSlug.safeParse(customEnv.value)
  if (!parsed.success) return
  if (!form.envs.includes(parsed.data)) form.envs = normalizeSlugList([...form.envs, parsed.data])
  customEnv.value = ''
}

function toggleRealm(slug: string) {
  form.allowedRealms = form.allowedRealms.includes(slug)
    ? form.allowedRealms.filter((v) => v !== slug)
    : normalizeSlugList([...form.allowedRealms, slug])
}

function addRealm() {
  const parsed = SceneSlug.safeParse(customRealm.value)
  if (!parsed.success) return
  if (!form.allowedRealms.includes(parsed.data)) {
    form.allowedRealms = normalizeSlugList([...form.allowedRealms, parsed.data])
  }
  customRealm.value = ''
}

function toggleFocusRealm(slug: string) {
  form.focusRealms = form.focusRealms.includes(slug)
    ? form.focusRealms.filter((v) => v !== slug)
    : normalizeSlugList([...form.focusRealms, slug])
}

function addFocusRealm() {
  const parsed = SceneSlug.safeParse(customFocusRealm.value)
  if (!parsed.success) return
  if (!form.focusRealms.includes(parsed.data)) {
    form.focusRealms = normalizeSlugList([...form.focusRealms, parsed.data])
  }
  customFocusRealm.value = ''
}

const validationProblem = computed(() => {
  const parsed = KeyName.safeParse(form.name)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? '请填写名称')
})

async function submit() {
  if (saving.value || validationProblem.value || (props.editing && !isDirty.value)) return
  saving.value = true
  error.value = null
  try {
    const allowedRealms = effectiveAllowedRealms()
    const focusRealms = form.focusRealms.length ? normalizeSlugList(form.focusRealms) : null
    if (props.editing) {
      const updated = await api.updateKey(props.editing.id, {
        name: form.name.trim(),
        runtimeFamily: form.runtimeFamily,
        envs: form.envs,
        allowedRealms,
        focusRealms,
        canWrite: form.canWrite,
        canResolveCredentials: form.canResolveCredentials,
      })
      open.value = false
      emit('saved', updated)
    } else {
      const res = await api.createKey({
        name: form.name.trim(),
        runtimeFamily: form.runtimeFamily,
        envs: form.envs,
        allowedRealms,
        focusRealms,
        canWrite: form.canWrite,
        canResolveCredentials: form.canResolveCredentials,
      })
      issued.value = res
      emit('saved', res.item)
    }
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败，请重试'
  } finally {
    saving.value = false
  }
}

function closeOnce() {
  issued.value = null
  open.value = false
}
</script>

<template>
  <!-- 460px 右滑编辑 / 签发抽屉 -->
  <USlideover
    :open="open && !issued"
    side="right"
    :title="editing ? '编辑访问密钥' : '签发访问密钥'"
    :description="
      editing
        ? `${editing.prefix} · ${editing.lastUsedAt ? `最近使用 ${formatRelative(editing.lastUsedAt)}` : '尚未使用'}`
        : '配置终端环境、场域边界与访问权限'
    "
    :dismissible="!saving"
    :ui="{
      content: 'max-w-[460px] sm:max-w-[460px]',
      body: 'p-0 sm:p-0',
      footer: 'px-5 py-3 sm:px-5',
    }"
    @update:open="(v) => !v && !saving && (open = false)"
  >
    <template #body>
      <div class="drawer-sections">
        <!-- 基本资料 -->
        <section class="drawer-section">
          <h3 class="drawer-sec-title">基本资料</h3>
          <UFormField label="名称">
            <UInput
              v-model="form.name"
              placeholder="例如 MacBook Claude Code"
              class="w-full"
              :maxlength="KEY_NAME_MAX"
            />
          </UFormField>

          <UFormField label="客户端类型">
            <USelect
              v-model="form.runtimeFamily"
              :items="RUNTIME_OPTIONS"
              value-key="value"
              class="w-full"
            />
          </UFormField>

          <div class="space-y-1.5">
            <p class="section-caption">
              <UIcon :name="icons.env" class="section-caption-icon" aria-hidden="true" />
              <span>终端环境（系统名或自定义主机标识）</span>
            </p>
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="slug in normalizeSlugList([...BUILTIN_ENVS, ...form.envs])"
                :key="slug"
                type="button"
                size="xs"
                :color="form.envs.includes(slug) ? 'primary' : 'neutral'"
                :variant="form.envs.includes(slug) ? 'solid' : 'outline'"
                @click="toggleEnv(slug)"
              >
                {{ envDisplayName(slug) }}
              </UButton>
              <UInput
                v-model="customEnv"
                size="xs"
                placeholder="如 home-24"
                class="w-28"
                @keydown.enter.prevent="addEnv"
                @blur="addEnv"
              />
            </div>
            <p class="text-xs text-muted">
              可填系统名（mac、linux、win）或自定义主机标识（如
              home-24）。多标签按任一命中；单机专用记忆若需隔离，仅标主机标识。
            </p>
          </div>
        </section>

        <!-- 权限范围 -->
        <section class="drawer-section">
          <h3 class="drawer-sec-title">权限范围</h3>

          <div class="space-y-2">
            <p class="section-caption">
              <UIcon :name="icons.realm" class="section-caption-icon" aria-hidden="true" />
              <span>允许场域边界</span>
            </p>
            <SegmentedChoice
              v-model="form.realmMode"
              :items="realmModeOptions"
              label="允许场域边界"
              compact
            />

            <div v-if="form.realmMode === 'scoped'" class="space-y-1.5 pt-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <UButton
                  v-for="slug in realmChoices"
                  :key="slug"
                  type="button"
                  size="xs"
                  :color="form.allowedRealms.includes(slug) ? 'primary' : 'neutral'"
                  :variant="form.allowedRealms.includes(slug) ? 'solid' : 'outline'"
                  @click="toggleRealm(slug)"
                >
                  {{ slug }}
                </UButton>
                <UInput
                  v-model="customRealm"
                  size="xs"
                  placeholder="新增场域"
                  class="w-24"
                  @keydown.enter.prevent="addRealm"
                  @blur="addRealm"
                />
              </div>
              <p v-if="!form.allowedRealms.length" class="text-xs text-muted">
                未勾选具体场域时等效于「仅通用」，仅可访问未限定场域的通用记忆。
              </p>
            </div>
            <p v-else-if="form.realmMode === 'generic'" class="text-xs text-muted">
              仅可访问未限定场域的通用记忆；托管凭据解析需限定具体场域或选择不限场域。
            </p>
          </div>

          <div class="space-y-1.5">
            <p class="section-caption">
              <UIcon :name="icons.focus" class="section-caption-icon" aria-hidden="true" />
              <span>启动默认场域（可选）</span>
            </p>
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="slug in focusRealmOptions"
                :key="`focus:${slug}`"
                type="button"
                size="xs"
                :color="form.focusRealms.includes(slug) ? 'primary' : 'neutral'"
                :variant="form.focusRealms.includes(slug) ? 'solid' : 'outline'"
                @click="toggleFocusRealm(slug)"
              >
                {{ slug }}
              </UButton>
              <UInput
                v-model="customFocusRealm"
                size="xs"
                placeholder="新增默认场域"
                class="w-28"
                @keydown.enter.prevent="addFocusRealm"
                @blur="addFocusRealm"
              />
            </div>
            <NoteLine v-if="outOfScopeFocusRealms.length" tone="warning" flush>
              默认场域
              {{ outOfScopeFocusRealms.join('、') }}
              不在上方允许范围内，启动聚焦仅在允许场域内生效。
            </NoteLine>
            <p v-else class="text-xs text-muted">仅作会话启动与召回默认聚焦，不放宽允许场域。</p>
          </div>

          <div class="switch-stack">
            <div class="switch-row">
              <USwitch v-model="form.canWrite" label="允许写入记忆" />
              <p class="text-xs text-muted">
                关闭后仅可检索记忆，不写入新记忆，也不自动记录会话摘要。
              </p>
            </div>

            <div class="switch-row">
              <USwitch v-model="form.canResolveCredentials" label="允许解析托管凭据" />
              <p class="text-xs text-muted">
                开启后可通过 <code class="font-mono">kioku run</code> 解析允许场域内的托管凭据。
              </p>
              <p v-if="form.canResolveCredentials" class="cred-scope-line">
                <template v-if="matchingCredentialCount !== null">
                  按当前场域边界，匹配
                  <strong class="tabular-nums">{{ matchingCredentialCount }}</strong>
                  条托管凭据 ·
                </template>
                <template v-else-if="credentialsQuery.isError.value">
                  暂无法统计当前场域边界内的托管凭据 ·
                </template>
                <template v-else>正在统计当前场域边界内的托管凭据 · </template>
                <RouterLink
                  :to="{ name: 'credentials' }"
                  class="text-primary"
                  @click="open = false"
                >
                  前往凭据
                </RouterLink>
              </p>
            </div>
          </div>

          <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        </section>

        <!-- 密钥安全（仅编辑现有密钥时展示） -->
        <section v-if="editing" class="drawer-section">
          <h3 class="drawer-sec-title">密钥安全</h3>
          <div class="security-row">
            <div class="min-w-0">
              <p class="text-sm font-medium">轮换访问密钥</p>
              <p class="text-xs text-muted">生成新密钥并立即停用旧密钥。</p>
            </div>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.rotate"
              class="shrink-0 whitespace-nowrap"
              @click="emit('requestRotate', editing)"
            >
              轮换
            </UButton>
          </div>
          <div class="security-row security-row-border">
            <div class="min-w-0">
              <p class="text-sm font-medium text-error">吊销访问密钥</p>
              <p class="text-xs text-muted">吊销后永久失效，不可恢复。</p>
            </div>
            <UButton
              size="xs"
              color="error"
              variant="outline"
              :icon="icons.revoked"
              class="shrink-0 whitespace-nowrap"
              @click="emit('requestRevoke', editing)"
            >
              吊销
            </UButton>
          </div>
        </section>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted">
          {{ !error && validationProblem ? validationProblem : '' }}
        </span>
        <div class="flex items-center gap-2">
          <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false">
            取消
          </UButton>
          <UButton
            :icon="icons.check"
            :loading="saving"
            :disabled="Boolean(validationProblem) || (Boolean(editing) && !isDirty)"
            @click="submit"
          >
            {{ editing ? '保存更改' : '签发访问密钥' }}
          </UButton>
        </div>
      </div>
    </template>
  </USlideover>

  <!-- 一次性明文访问密钥展示期间禁止遮罩、Esc 或右上角关闭，只能点确认 -->
  <UModal
    :open="issued !== null"
    title="访问密钥已签发"
    :dismissible="false"
    :close="false"
    :ui="{ content: 'max-w-lg sm:max-w-lg' }"
  >
    <template #body>
      <div v-if="issued" class="space-y-4">
        <NoteLine tone="warning">
          明文访问密钥仅显示这一次，关闭后无法再次查看，请立即复制保存。
        </NoteLine>
        <div class="secret-row">
          <code class="secret-code">{{ issued.key }}</code>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.copy"
            class="shrink-0 whitespace-nowrap"
            @click="copy(issued.key, '已复制访问密钥')"
          >
            复制
          </UButton>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton :icon="icons.check" @click="closeOnce">我已保存</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.drawer-sections {
  display: flex;
  flex-direction: column;
}
.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
}
.drawer-section + .drawer-section {
  border-top: 1px solid var(--ui-border);
}
.drawer-sec-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.section-caption {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
}
.section-caption-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.switch-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.switch-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cred-scope-line {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
}
.security-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.security-row-border {
  padding-top: 10px;
  border-top: 1px solid var(--ui-border);
}
.secret-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.secret-code {
  min-width: 0;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  word-break: break-all;
}
</style>
