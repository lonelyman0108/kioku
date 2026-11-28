<script setup lang="ts">
import {
  ChangePasswordRequest,
  DISPLAY_NAME_MAX,
  DisplayName,
  type SessionItem,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useLogout } from '../composables/useLogout'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { formatRelative, formatShort, formatTime } from '../time'
import { parseUserAgent, type SessionDeviceKind } from '../userAgent'
import ConsequenceModal from './ConsequenceModal.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SectionHeading from './ui/SectionHeading.vue'

const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const logout = useLogout()

// 账号资料
const displayName = ref('')
watch(
  () => me.data.value?.displayName,
  (val) => {
    if (val !== undefined) displayName.value = val
  },
  { immediate: true },
)
const profileBusy = ref(false)
const profileDirty = computed(
  () =>
    me.data.value !== undefined &&
    me.data.value !== null &&
    displayName.value.trim() !== me.data.value.displayName,
)
const profileValid = computed(() => DisplayName.safeParse(displayName.value).success)

async function saveProfile() {
  if (profileBusy.value || !profileDirty.value || !profileValid.value) return
  profileBusy.value = true
  try {
    const updated = await api.updateProfile({ displayName: displayName.value.trim() })
    queryClient.setQueryData(ME_KEY, updated)
    toast.add({ title: '显示名已更新', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    profileBusy.value = false
  }
}

// 修改密码
const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const passwordBusy = ref(false)
const passwordError = ref<string | null>(null)

const passwordMismatch = computed(
  () =>
    passwordForm.confirmPassword.length > 0 &&
    passwordForm.newPassword !== passwordForm.confirmPassword,
)

const passwordReady = computed(
  () =>
    passwordForm.currentPassword.length > 0 &&
    passwordForm.newPassword.length >= 10 &&
    passwordForm.newPassword === passwordForm.confirmPassword,
)

const passwordDirty = computed(
  () =>
    passwordForm.currentPassword.length > 0 ||
    passwordForm.newPassword.length > 0 ||
    passwordForm.confirmPassword.length > 0,
)

watch(
  () => profileDirty.value || passwordDirty.value,
  (changed) => {
    dirtyModel.value = changed
  },
  { immediate: true },
)

async function changePassword() {
  if (passwordBusy.value || !passwordReady.value) return
  const parsed = ChangePasswordRequest.safeParse({
    currentPassword: passwordForm.currentPassword,
    newPassword: passwordForm.newPassword,
  })
  if (!parsed.success) {
    passwordError.value = parsed.error.issues[0]?.message ?? '请检查密码格式'
    return
  }
  passwordBusy.value = true
  passwordError.value = null
  try {
    await api.changePassword(parsed.data)
    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    toast.add({ title: '密码已更新，其余登录设备已自动下线', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] })
  } catch (err) {
    passwordError.value = err instanceof ApiError ? err.message : '修改密码失败'
  } finally {
    passwordBusy.value = false
  }
}

// 登录设备
const sessionsQuery = useQuery({
  queryKey: ['auth-sessions'] as const,
  queryFn: () => api.sessions(),
})
const sessions = computed(() => sessionsQuery.data.value?.items ?? [])
const otherSessions = computed(() => sessions.value.filter((s) => !s.current))

function deviceIconOf(current: boolean, kind: SessionDeviceKind): string {
  if (current) return icons.currentDevice
  if (kind === 'mobile') return icons.deviceMobile
  if (kind === 'tablet') return icons.deviceTablet
  return icons.deviceDesktop
}

const sessionRows = computed(() =>
  sessions.value.map((session) => {
    const ua = parseUserAgent(session.userAgent)
    return {
      session,
      uaLabel: ua.label,
      icon: deviceIconOf(session.current, ua.deviceKind),
    }
  }),
)

// 单台设备下线确认
const revokingSession = ref<{ session: SessionItem; uaLabel: string } | null>(null)
const revokeBusy = ref(false)
const revokeError = ref<string | null>(null)

function requestRevokeSession(session: SessionItem, uaLabel: string) {
  revokingSession.value = { session, uaLabel }
  revokeError.value = null
}

async function confirmRevokeSession() {
  const target = revokingSession.value
  if (!target || revokeBusy.value) return
  revokeBusy.value = true
  revokeError.value = null
  try {
    await api.revokeSession(target.session.id)
    revokingSession.value = null
    toast.add({ title: `已下线设备「${target.uaLabel}」`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] })
  } catch (err) {
    revokeError.value = err instanceof ApiError ? err.message : '操作失败'
  } finally {
    revokeBusy.value = false
  }
}

// 一键下线其他设备
const kickOthersOpen = ref(false)
const kickOthersBusy = ref(false)
const kickOthersError = ref<string | null>(null)

async function confirmKickOthers() {
  const targets = otherSessions.value
  if (!targets.length || kickOthersBusy.value) return
  kickOthersBusy.value = true
  kickOthersError.value = null
  try {
    const results = await Promise.allSettled(targets.map((s) => api.revokeSession(s.id)))
    const failed = results.filter((r) => r.status === 'rejected').length
    const succeeded = results.length - failed
    void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] })
    if (failed === 0) {
      kickOthersOpen.value = false
      toast.add({ title: `已下线其余 ${succeeded} 台设备`, color: 'success' })
    } else {
      kickOthersError.value = `已下线 ${succeeded} 台，仍有 ${failed} 台未能下线，请重试`
    }
  } finally {
    kickOthersBusy.value = false
  }
}
</script>

<template>
  <article class="editor-pane is-single-col">
    <header class="editor-head">
      <div class="head-main">
        <div class="head-identity">
          <div class="head-title-row">
            <h1>账号与登录设备</h1>
          </div>
          <div class="head-status-line">
            <span v-if="me.data.value">
              用户名：<code class="font-mono">{{ me.data.value.username }}</code>
            </span>
            <span v-if="me.data.value" class="status-sep" aria-hidden="true">·</span>
            <span class="tabular-nums">{{ sessions.length }} 台已登录设备</span>
          </div>
        </div>

        <div v-if="otherSessions.length > 0" class="head-actions">
          <UButton
            size="sm"
            color="error"
            variant="outline"
            :icon="icons.logout"
            class="shrink-0 whitespace-nowrap"
            @click="((kickOthersOpen = true), (kickOthersError = null))"
          >
            下线其他设备
          </UButton>
        </div>
      </div>
    </header>

    <div class="editor-scroll">
      <div class="page-stack">
        <!-- 账号资料 -->
        <section class="paper-section">
          <SectionHeading title="账号资料" :icon="icons.account" :level="2" />
          <dl class="prop-list">
            <div class="prop-row">
              <dt class="prop-dt">用户名</dt>
              <dd class="prop-dd">
                <span class="username-static font-mono">{{ me.data.value?.username ?? '—' }}</span>
              </dd>
            </div>
            <div class="prop-row">
              <dt class="prop-dt"><label for="account-display-name">显示名</label></dt>
              <dd class="prop-dd">
                <form class="profile-inline-form" @submit.prevent="saveProfile">
                  <UInput
                    id="account-display-name"
                    v-model="displayName"
                    :maxlength="DISPLAY_NAME_MAX"
                    class="min-w-0 flex-1"
                  />
                  <UButton
                    type="submit"
                    size="sm"
                    :icon="icons.check"
                    :loading="profileBusy"
                    :disabled="!profileDirty || !profileValid"
                    class="shrink-0 whitespace-nowrap"
                  >
                    保存
                  </UButton>
                </form>
              </dd>
            </div>
          </dl>
        </section>

        <!-- 修改密码 -->
        <section class="paper-section">
          <SectionHeading title="修改密码" :icon="icons.lock" :level="2" />
          <form class="space-y-4" @submit.prevent="changePassword">
            <div class="grid gap-4 sm:grid-cols-2">
              <UFormField label="当前密码">
                <UInput
                  v-model="passwordForm.currentPassword"
                  type="password"
                  placeholder="输入当前密码"
                  autocomplete="current-password"
                  class="w-full"
                />
              </UFormField>
              <div class="hidden sm:block" aria-hidden="true" />
              <UFormField label="新密码" help="至少 10 位">
                <UInput
                  v-model="passwordForm.newPassword"
                  type="password"
                  placeholder="输入新密码"
                  autocomplete="new-password"
                  class="w-full"
                />
              </UFormField>
              <UFormField
                label="确认新密码"
                :error="passwordMismatch ? '两次输入的新密码不一致' : undefined"
              >
                <UInput
                  v-model="passwordForm.confirmPassword"
                  type="password"
                  placeholder="再次输入新密码"
                  autocomplete="new-password"
                  class="w-full"
                />
              </UFormField>
            </div>
            <p v-if="passwordError" class="text-sm text-error" role="alert">{{ passwordError }}</p>
            <div>
              <UButton
                type="submit"
                size="sm"
                :icon="icons.check"
                :loading="passwordBusy"
                :disabled="!passwordReady"
              >
                更新密码
              </UButton>
            </div>
          </form>
        </section>

        <!-- 登录设备 -->
        <section class="paper-section">
          <SectionHeading title="登录设备" :icon="icons.currentDevice" :level="2">
            <template #hint>
              <span class="section-count tabular-nums">{{ sessions.length }}</span>
            </template>
          </SectionHeading>

          <ReadFailureNote v-if="sessionsQuery.isError.value" :query="sessionsQuery" />
          <div v-if="sessionsQuery.isPending.value" class="space-y-2">
            <USkeleton v-for="n in 2" :key="n" class="h-12 w-full" />
          </div>
          <ul v-else class="device-list">
            <li
              v-for="{ session, uaLabel, icon } in sessionRows"
              :key="session.id"
              class="device-row"
            >
              <div class="device-lead">
                <UIcon
                  :name="icon"
                  class="session-icon"
                  :class="session.current ? 'is-current' : 'is-other'"
                  aria-hidden="true"
                />
                <div class="min-w-0 space-y-0.5">
                  <p class="device-title">
                    <span :title="session.userAgent ?? undefined">{{ uaLabel }}</span>
                    <span v-if="session.current" class="current-pill">当前设备</span>
                  </p>
                  <p class="device-meta">
                    <code class="font-mono">{{ session.clientAddress ?? '未知地址' }}</code>
                    <span aria-hidden="true">·</span>
                    <span>
                      登录于
                      <time :datetime="session.createdAt" :title="formatTime(session.createdAt)">
                        {{ formatShort(session.createdAt) }}
                      </time>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      最近活动
                      <time
                        :datetime="session.lastActiveAt"
                        :title="formatTime(session.lastActiveAt)"
                      >
                        {{ formatRelative(session.lastActiveAt) }}
                      </time>
                    </span>
                  </p>
                </div>
              </div>

              <UButton
                v-if="session.current"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.logout"
                class="shrink-0 whitespace-nowrap"
                @click="logout"
              >
                退出当前设备
              </UButton>
              <UButton
                v-else
                size="xs"
                color="error"
                variant="outline"
                :icon="icons.logout"
                class="shrink-0 whitespace-nowrap"
                @click="requestRevokeSession(session, uaLabel)"
              >
                下线
              </UButton>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <ConsequenceModal
      :open="revokingSession !== null"
      :title="`下线设备「${revokingSession?.uaLabel ?? ''}」？`"
      :consequences="[
        `来自 ${revokingSession?.session.clientAddress ?? '未知地址'} 的登录会话将立即失效，须重新输入密码登录。`,
        '已签发的访问密钥不受影响。',
      ]"
      action="确认下线"
      :action-icon="icons.logout"
      :busy="revokeBusy"
      :error="revokeError"
      @confirm="confirmRevokeSession"
      @close="revokingSession = null"
    />

    <ConsequenceModal
      :open="kickOthersOpen"
      :title="`下线其余 ${otherSessions.length} 台登录设备？`"
      :consequences="[
        `除当前设备外的 ${otherSessions.length} 个登录会话将立即失效，须重新输入密码登录。`,
        '已签发的访问密钥不受影响。',
      ]"
      action="确认全部下线"
      :action-icon="icons.logout"
      :busy="kickOthersBusy"
      :error="kickOthersError"
      @confirm="confirmKickOthers"
      @close="kickOthersOpen = false"
    />
  </article>
</template>

<style scoped>
.editor-pane {
  --canvas-max: 880px;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.editor-head {
  flex: none;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.head-identity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 18rem;
}
.head-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.head-title-row h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.35;
  color: var(--ui-text-highlighted);
}
.head-status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.status-sep {
  color: var(--ui-border-accented);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: none;
}
.editor-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px 36px;
}
.page-stack {
  display: flex;
  flex-direction: column;
  gap: 28px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.paper-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.section-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.prop-list {
  margin: 0;
  display: flex;
  flex-direction: column;
}
.prop-row {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
}
.prop-row:last-child {
  border-bottom: 0;
}
.prop-dt {
  font-size: 13px;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.prop-dd {
  margin: 0;
  min-width: 0;
}
.username-static {
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.profile-inline-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  max-width: 24rem;
}
.device-list {
  display: flex;
  flex-direction: column;
}
.device-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 14px;
  padding: 12px 2px;
  border-bottom: 1px solid var(--ui-border);
}
.device-lead {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  flex: 1 1 16rem;
}
.session-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 3px;
}
.session-icon.is-current {
  color: var(--ui-text-highlighted);
}
.session-icon.is-other {
  color: var(--ui-text-muted);
}
.device-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.device-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.current-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-success);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.4;
  color: var(--ui-success);
  white-space: nowrap;
}

@media (max-width: 767.98px) {
  .editor-head {
    padding: 12px 14px 10px;
  }
  .head-title-row h1 {
    font-size: 19px;
  }
  .editor-scroll {
    padding: 14px 14px 32px;
  }
  .prop-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
}
</style>
