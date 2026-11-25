<script setup lang="ts">
import {
  ChangePasswordRequest,
  DISPLAY_NAME_MAX,
  DisplayName,
  versionLabel,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useLogout } from '../composables/useLogout'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { formatRelative, formatTime } from '../time'
import DataTransferPanel from './DataTransferPanel.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SectionHeading from './ui/SectionHeading.vue'

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
const profileDirty = computed(() => displayName.value.trim() !== (me.data.value?.displayName ?? ''))
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
})
const passwordBusy = ref(false)
const passwordError = ref<string | null>(null)

async function changePassword() {
  if (passwordBusy.value) return
  const parsed = ChangePasswordRequest.safeParse(passwordForm)
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
    toast.add({ title: '密码已更新', color: 'success' })
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
const revokingId = ref<string | null>(null)

async function revokeSession(id: string) {
  if (revokingId.value) return
  revokingId.value = id
  try {
    await api.revokeSession(id)
    toast.add({ title: '已退出该设备', color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['auth-sessions'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
  } finally {
    revokingId.value = null
  }
}

const versionText = computed(() =>
  me.data.value?.version ? `Kioku ${versionLabel(me.data.value.version)}` : null,
)
</script>

<template>
  <div class="space-y-8">
    <!-- 账号资料 -->
    <section class="space-y-3">
      <SectionHeading title="账号资料" :level="2" />
      <p v-if="me.data.value" class="text-xs text-muted">
        用户名：<span class="font-mono">{{ me.data.value.username }}</span>
      </p>
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="saveProfile">
        <UFormField label="显示名" class="w-full max-w-xs">
          <UInput v-model="displayName" :maxlength="DISPLAY_NAME_MAX" class="w-full" />
        </UFormField>
        <UButton
          type="submit"
          size="sm"
          :loading="profileBusy"
          :disabled="!profileDirty || !profileValid"
        >
          保存
        </UButton>
      </form>
    </section>

    <!-- 修改密码 -->
    <section class="space-y-3">
      <SectionHeading title="修改密码" :level="2" />
      <form class="max-w-sm space-y-3" @submit.prevent="changePassword">
        <UFormField label="当前密码">
          <UInput
            v-model="passwordForm.currentPassword"
            type="password"
            autocomplete="current-password"
            class="w-full"
          />
        </UFormField>
        <UFormField label="新密码" help="至少 10 位">
          <UInput
            v-model="passwordForm.newPassword"
            type="password"
            autocomplete="new-password"
            class="w-full"
          />
        </UFormField>
        <p v-if="passwordError" class="text-sm text-error" role="alert">{{ passwordError }}</p>
        <UButton
          type="submit"
          size="sm"
          :loading="passwordBusy"
          :disabled="!passwordForm.currentPassword || passwordForm.newPassword.length < 10"
        >
          更新密码
        </UButton>
      </form>
    </section>

    <!-- 登录设备 -->
    <section class="space-y-3">
      <SectionHeading title="登录设备" :level="2" />
      <ReadFailureNote v-if="sessionsQuery.isError.value" :query="sessionsQuery" />
      <div v-if="sessionsQuery.isPending.value" class="space-y-2">
        <USkeleton v-for="n in 2" :key="n" class="h-12 w-full" />
      </div>
      <ul v-else class="divide-y divide-default border-y border-default">
        <li
          v-for="session in sessions"
          :key="session.id"
          class="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
        >
          <div class="min-w-0 space-y-0.5">
            <p class="flex flex-wrap items-center gap-2">
              <UIcon
                v-if="session.current"
                :name="icons.currentDevice"
                class="session-icon"
                aria-hidden="true"
              />
              <span class="font-medium">{{ session.clientAddress ?? '未知地址' }}</span>
              <span v-if="session.current" class="current-pill">当前设备</span>
            </p>
            <p class="truncate text-xs text-muted">
              {{ session.userAgent ?? '未知浏览器' }} · 最近活动
              <time :datetime="session.lastActiveAt" :title="formatTime(session.lastActiveAt)">
                {{ formatRelative(session.lastActiveAt) }}
              </time>
            </p>
          </div>
          <UButton
            v-if="session.current"
            size="xs"
            color="neutral"
            variant="outline"
            :icon="icons.logout"
            @click="logout"
          >
            退出当前设备
          </UButton>
          <UButton
            v-else
            size="xs"
            color="error"
            variant="ghost"
            :loading="revokingId === session.id"
            @click="revokeSession(session.id)"
          >
            下线
          </UButton>
        </li>
      </ul>
    </section>

    <!-- 数据导入与导出 -->
    <DataTransferPanel />

    <footer v-if="versionText" class="border-t border-default pt-4 text-xs text-muted">
      {{ versionText }}
    </footer>
  </div>
</template>

<style scoped>
.session-icon {
  display: inline-block;
  flex: none;
  width: 15px;
  height: 15px;
}
.current-pill {
  padding: 0 5px;
  border: 1px solid var(--ui-rule);
  font-size: 12px;
  line-height: 1.4;
}
</style>
