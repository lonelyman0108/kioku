<script setup lang="ts">
import {
  BUILTIN_ENVS,
  DeviceUserCode,
  formatDeviceUserCode,
  KeyName,
  normalizeSlugList,
  SceneSlug,
  type DeviceGrantApproveResponse,
  type DeviceGrantLookupResponse,
  type RuntimeFamily,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import RuntimeLabel from '../components/RuntimeLabel.vue'
import EntryFrame from '../components/ui/EntryFrame.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import PropertyList, { type Property } from '../components/ui/PropertyList.vue'
import SectionHeading from '../components/ui/SectionHeading.vue'
import { useNow } from '../composables/useNow'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { envDisplayName } from '../labels'
import { runtimeName } from '../runtimes'
import { settingsRoute } from '../routes'
import { formatTime } from '../time'

// 浏览器授权确认页：确认码只由用户输入，不进地址与缓存；批准操作不放进 <form> 避免误回车签发
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const { me } = useSession()

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
const info = ref<DeviceGrantLookupResponse | null>(null)

interface PlatformRow {
  runtimeFamily: RuntimeFamily
  selected: boolean
  keyName: string
}
const rows = ref<PlatformRow[]>([])
const envs = ref<string[]>([])
const customEnv = ref('')
const restrictRealms = ref(false)
const allowedRealms = ref<string[]>([])
const customRealm = ref('')
const focusRealms = ref<string[]>([])
const customFocusRealm = ref('')
const canWrite = ref(true)
const canResolveCredentials = ref(false)

const submitting = ref<'approve' | 'deny' | null>(null)
const error = ref<string | null>(null)
const approved = ref<DeviceGrantApproveResponse | null>(null)

const now = useNow(
  10_000,
  computed(() => step.value === 'review'),
)
const expired = computed(
  () => Boolean(info.value) && new Date(info.value!.expiresAt).getTime() <= now.value.getTime(),
)

function defaultKeyName(runtime: RuntimeFamily, clientName: string | null): string {
  const base = runtimeName(runtime)
  return clientName ? `${base}（${clientName}）`.slice(0, 64) : base
}

async function lookup() {
  if (looking.value) return
  notice.value = null
  const parsed = DeviceUserCode.safeParse(codeInput.value)
  if (!parsed.success) {
    codeError.value = parsed.error.issues[0]?.message ?? '确认码格式有误'
    return
  }
  looking.value = true
  codeError.value = null
  try {
    const res = await api.lookupDeviceGrant(parsed.data)
    info.value = res
    userCode.value = parsed.data
    rows.value = res.platforms.map((p) => ({
      runtimeFamily: p.runtimeFamily,
      selected: true,
      keyName: defaultKeyName(p.runtimeFamily, p.clientName ?? res.clientName),
    }))
    envs.value = []
    restrictRealms.value = false
    allowedRealms.value = []
    focusRealms.value = []
    customFocusRealm.value = ''
    canWrite.value = true
    canResolveCredentials.value = false
    error.value = null
    step.value = 'review'
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      codeError.value = '确认码无效或已过期，请核对命令行显示并重试'
    } else {
      codeError.value = err instanceof ApiError ? err.message : '查询确认码失败'
    }
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
  approved.value = null
  error.value = null
}

function toggleEnv(slug: string) {
  envs.value = envs.value.includes(slug)
    ? envs.value.filter((item) => item !== slug)
    : normalizeSlugList([...envs.value, slug])
}

function addCustomEnv() {
  const parsed = SceneSlug.safeParse(customEnv.value)
  if (!parsed.success) return
  if (!envs.value.includes(parsed.data))
    envs.value = normalizeSlugList([...envs.value, parsed.data])
  customEnv.value = ''
}

function addCustomRealm() {
  const parsed = SceneSlug.safeParse(customRealm.value)
  if (!parsed.success) return
  if (!allowedRealms.value.includes(parsed.data)) {
    allowedRealms.value = normalizeSlugList([...allowedRealms.value, parsed.data])
  }
  customRealm.value = ''
}

function removeRealm(slug: string) {
  allowedRealms.value = allowedRealms.value.filter((item) => item !== slug)
}

function toggleFocusRealm(slug: string) {
  focusRealms.value = focusRealms.value.includes(slug)
    ? focusRealms.value.filter((item) => item !== slug)
    : normalizeSlugList([...focusRealms.value, slug])
}

function addCustomFocusRealm() {
  const parsed = SceneSlug.safeParse(customFocusRealm.value)
  if (!parsed.success) return
  if (!focusRealms.value.includes(parsed.data)) {
    focusRealms.value = normalizeSlugList([...focusRealms.value, parsed.data])
  }
  customFocusRealm.value = ''
}

const customEnvs = computed(() =>
  envs.value.filter((e) => !(BUILTIN_ENVS as readonly string[]).includes(e)),
)
const customRealms = computed(() =>
  allowedRealms.value.filter((r) => r !== 'work' && r !== 'personal'),
)
const focusRealmOptions = computed(() =>
  normalizeSlugList(['work', 'personal', ...allowedRealms.value, ...focusRealms.value]),
)
const outOfScopeFocusRealms = computed(() =>
  restrictRealms.value ? focusRealms.value.filter((r) => !allowedRealms.value.includes(r)) : [],
)
const selectedCount = computed(() => rows.value.filter((r) => r.selected).length)
const validationProblem = computed(() => {
  if (!selectedCount.value) return '请至少选择一个客户端'
  for (const row of rows.value) {
    if (!row.selected) continue
    const parsed = KeyName.safeParse(row.keyName)
    if (!parsed.success) return parsed.error.issues[0]?.message ?? '请填写访问密钥名称'
  }
  return null
})

const requestFacts = computed<Property[][]>(() => {
  if (!info.value) return []
  return [
    [
      { key: 'code', label: '确认码', value: formatDeviceUserCode(userCode.value) },
      ...(info.value.clientName
        ? [{ key: 'machine', label: '终端', value: info.value.clientName }]
        : []),
      ...(info.value.clientAddress
        ? [{ key: 'addr', label: '来源地址', value: info.value.clientAddress }]
        : []),
      { key: 'expires', label: '有效至', value: formatTime(info.value.expiresAt) },
    ],
  ]
})

async function approve() {
  if (submitting.value || expired.value || validationProblem.value) return
  submitting.value = 'approve'
  error.value = null
  try {
    approved.value = await api.approveDeviceGrant({
      userCode: userCode.value,
      envs: envs.value,
      allowedRealms: restrictRealms.value ? allowedRealms.value : null,
      focusRealms: focusRealms.value.length ? focusRealms.value : null,
      canWrite: canWrite.value,
      canResolveCredentials: canResolveCredentials.value,
      items: rows.value.map((row) =>
        row.selected
          ? { runtimeFamily: row.runtimeFamily, keyName: row.keyName.trim() }
          : { runtimeFamily: row.runtimeFamily, skip: true as const },
      ),
    })
    void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
    step.value = 'approved'
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      restart('该浏览器授权申请已失效或已被处理，请在命令行重新发起。')
      return
    }
    error.value = err instanceof ApiError ? err.message : '批准失败，请重试'
  } finally {
    submitting.value = null
  }
}

async function deny() {
  if (submitting.value) return
  submitting.value = 'deny'
  error.value = null
  try {
    await api.denyDeviceGrant(userCode.value)
    step.value = 'denied'
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
      restart('该浏览器授权申请已失效或已被处理。')
      return
    }
    error.value = err instanceof ApiError ? err.message : '拒绝失败，请重试'
  } finally {
    submitting.value = null
  }
}
</script>

<template>
  <EntryFrame :wide="step === 'review'">
    <SectionHeading title="浏览器授权" :level="1" :icon="icons.shieldCheck" />

    <template v-if="step === 'code'">
      <NoteLine v-if="notice" class="mt-4" tone="warning">{{ notice }}</NoteLine>
      <p class="mt-3 text-sm text-muted">输入命令行显示的 8 位确认码，以签发对应的访问密钥。</p>
      <form class="mt-4 space-y-4" @submit.prevent="lookup">
        <UFormField label="确认码" :error="codeError ?? undefined">
          <UInput
            v-model="codeInput"
            size="lg"
            placeholder="例如 BCDF-GHJK"
            class="w-full"
            :ui="{ base: 'font-mono uppercase tracking-widest' }"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            maxlength="24"
            required
          />
        </UFormField>
        <UButton type="submit" size="lg" block :trailing-icon="icons.arrowRight" :loading="looking">
          继续
        </UButton>
      </form>
    </template>

    <template v-else-if="step === 'review' && info">
      <NoteLine v-if="expired" class="mt-4" tone="error">
        该确认码已过期，请在命令行重新发起浏览器授权。
        <template #actions>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.restore"
            @click="restart()"
          >
            重新输入
          </UButton>
        </template>
      </NoteLine>

      <div class="mt-4 space-y-5">
        <PropertyList :groups="requestFacts" />

        <section class="space-y-2.5">
          <SectionHeading title="签发对象" :level="2" :icon="icons.terminal" />
          <div
            v-for="row in rows"
            :key="row.runtimeFamily"
            class="grid items-center gap-3 border-b border-default py-2.5 sm:grid-cols-[180px_minmax(0,1fr)]"
          >
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <UCheckbox v-model="row.selected" />
              <RuntimeLabel :family="row.runtimeFamily" />
            </label>
            <UInput
              v-model="row.keyName"
              :disabled="!row.selected"
              placeholder="访问密钥名称"
              class="w-full"
              maxlength="64"
            />
          </div>
        </section>

        <section class="space-y-3">
          <SectionHeading title="终端环境与权限" :level="2" :icon="icons.sliders">
            <template #hint>
              <Hint>
                终端环境用于启动加载与召回时自动匹配当前系统；限定场域是硬边界，仅返回允许场域及通用记忆。
              </Hint>
            </template>
          </SectionHeading>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted">终端环境（可选）</p>
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="env in BUILTIN_ENVS"
                :key="env"
                type="button"
                size="xs"
                :color="envs.includes(env) ? 'primary' : 'neutral'"
                :variant="envs.includes(env) ? 'solid' : 'outline'"
                @click="toggleEnv(env)"
              >
                {{ envDisplayName(env) }}
              </UButton>
              <UButton
                v-for="env in customEnvs"
                :key="env"
                type="button"
                size="xs"
                color="primary"
                variant="solid"
                :trailing-icon="icons.cancel"
                :aria-label="`移除环境 ${env}`"
                @click="toggleEnv(env)"
              >
                {{ env }}
              </UButton>
              <div class="flex items-center gap-1">
                <UInput
                  v-model="customEnv"
                  size="xs"
                  placeholder="自定义环境"
                  class="w-28"
                  @keydown.enter.prevent="addCustomEnv"
                  @blur="addCustomEnv"
                />
                <UButton
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.add"
                  @click="addCustomEnv"
                >
                  添加
                </UButton>
              </div>
            </div>
          </div>

          <div class="space-y-2">
            <USwitch v-model="restrictRealms" label="限定允许访问的场域" />
            <div v-if="restrictRealms" class="space-y-2 pt-1">
              <div class="flex flex-wrap gap-1.5">
                <UButton
                  v-for="realm in ['work', 'personal']"
                  :key="realm"
                  type="button"
                  size="xs"
                  :color="allowedRealms.includes(realm) ? 'primary' : 'neutral'"
                  :variant="allowedRealms.includes(realm) ? 'solid' : 'outline'"
                  @click="
                    allowedRealms.includes(realm)
                      ? removeRealm(realm)
                      : (allowedRealms = normalizeSlugList([...allowedRealms, realm]))
                  "
                >
                  {{ realm }}
                </UButton>
                <UButton
                  v-for="realm in customRealms"
                  :key="realm"
                  type="button"
                  size="xs"
                  color="primary"
                  variant="solid"
                  :trailing-icon="icons.cancel"
                  :aria-label="`移除场域 ${realm}`"
                  @click="removeRealm(realm)"
                >
                  {{ realm }}
                </UButton>
                <div class="flex items-center gap-1">
                  <UInput
                    v-model="customRealm"
                    size="xs"
                    placeholder="添加场域"
                    class="w-28"
                    @keydown.enter.prevent="addCustomRealm"
                    @blur="addCustomRealm"
                  />
                  <UButton
                    type="button"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.add"
                    @click="addCustomRealm"
                  >
                    添加
                  </UButton>
                </div>
              </div>
              <p class="text-xs text-muted">留空列表表示只允许访问未限定场域的通用记忆。</p>
            </div>
          </div>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted">启动默认场域（可选）</p>
            <div class="flex flex-wrap items-center gap-1.5">
              <UButton
                v-for="realm in focusRealmOptions"
                :key="`focus:${realm}`"
                type="button"
                size="xs"
                :color="focusRealms.includes(realm) ? 'primary' : 'neutral'"
                :variant="focusRealms.includes(realm) ? 'solid' : 'outline'"
                @click="toggleFocusRealm(realm)"
              >
                {{ realm }}
              </UButton>
              <div class="flex items-center gap-1">
                <UInput
                  v-model="customFocusRealm"
                  size="xs"
                  placeholder="新增默认场域"
                  class="w-28"
                  @keydown.enter.prevent="addCustomFocusRealm"
                  @blur="addCustomFocusRealm"
                />
                <UButton
                  type="button"
                  size="xs"
                  color="neutral"
                  variant="outline"
                  :icon="icons.add"
                  @click="addCustomFocusRealm"
                >
                  添加
                </UButton>
              </div>
            </div>
            <NoteLine v-if="outOfScopeFocusRealms.length" tone="warning">
              默认场域
              {{ outOfScopeFocusRealms.join('、') }}
              不在上方允许范围内，启动聚焦仅在允许场域内生效。
            </NoteLine>
            <p v-else class="text-xs text-muted">
              仅作会话启动与召回默认聚焦，不放宽上方允许场域。
            </p>
          </div>

          <div class="flex flex-wrap gap-6 pt-1">
            <USwitch v-model="canWrite" label="允许写入记忆" />
            <USwitch v-model="canResolveCredentials" label="允许解析凭据值" />
          </div>
        </section>

        <p
          v-if="error || validationProblem"
          class="flex items-start gap-1.5 text-sm text-error"
          role="alert"
        >
          <UIcon
            :name="icons.error"
            class="mt-[3px] inline-block size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ error ?? validationProblem }}</span>
        </p>

        <div class="flex flex-wrap items-center justify-end gap-2 border-t border-default pt-4">
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            :icon="icons.back"
            :disabled="submitting !== null"
            @click="restart()"
          >
            返回
          </UButton>
          <UButton
            type="button"
            color="error"
            variant="outline"
            :icon="icons.shieldX"
            :loading="submitting === 'deny'"
            :disabled="submitting !== null || expired"
            @click="deny"
          >
            拒绝
          </UButton>
          <UButton
            type="button"
            :icon="icons.shieldCheck"
            :loading="submitting === 'approve'"
            :disabled="submitting !== null || expired || Boolean(validationProblem)"
            @click="approve"
          >
            批准并签发
          </UButton>
        </div>
      </div>
    </template>

    <template v-else-if="step === 'approved' && approved">
      <div class="mt-4 space-y-4">
        <NoteLine tone="success">已批准，客户端将在数秒内自动获取访问密钥。</NoteLine>
        <ul class="divide-y divide-default border-y border-default">
          <li
            v-for="item in approved.items"
            :key="item.runtimeFamily"
            class="flex items-center justify-between gap-3 py-2 text-sm"
          >
            <RuntimeLabel :family="item.runtimeFamily" />
            <span class="text-muted">{{ item.keyName }}</span>
          </li>
        </ul>
        <div class="flex gap-2">
          <UButton :to="settingsRoute('keys')" color="neutral" variant="outline" :icon="icons.keys">
            查看访问密钥
          </UButton>
          <UButton :to="{ name: 'memories' }" :icon="icons.memories">前往记忆</UButton>
        </div>
      </div>
    </template>

    <template v-else-if="step === 'denied'">
      <div class="mt-4 space-y-4">
        <NoteLine tone="warning">已拒绝本次浏览器授权申请。</NoteLine>
        <div class="flex gap-2">
          <UButton color="neutral" variant="outline" :icon="icons.restore" @click="restart()">
            处理下一个
          </UButton>
          <UButton :to="{ name: 'memories' }" :icon="icons.memories">返回记忆</UButton>
        </div>
      </div>
    </template>
  </EntryFrame>
</template>
