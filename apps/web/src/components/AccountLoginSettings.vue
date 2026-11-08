<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { LoginSession } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { changePasswordError, deviceName, newPasswordProblem, newPasswordReady } from '../accounts'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useLogout } from '../composables/useLogout'
import { fieldProblems } from '../composables/useSavedField'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { formatRelative, formatShort } from '../time'
import FlagTag from './strata/FlagTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 个人 › 账号与登录：资料（显示名可改，用户名只读）、修改密码、登录设备
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const logout = useLogout()
const SESSIONS_KEY = ['login-sessions']

// 显示名：基准是服务端最新的值，没改过时跟着它，改过的留着输入
const savedName = computed(() => me.data.value?.displayName)
const name = ref(savedName.value ?? '')
watch(savedName, (next, prev) => {
  if (next !== undefined && name.value === (prev ?? '')) name.value = next
})
const nameChanged = computed(
  () => savedName.value !== undefined && name.value.trim() !== savedName.value,
)
watch(nameChanged, (changed) => (dirtyModel.value = changed), { immediate: true })
const nameProblem = computed(() =>
  fieldProblems([
    { label: '显示名', issue: nameChanged.value && !name.value.trim() ? 'empty' : null },
  ]),
)

const savingName = ref(false)
async function saveName() {
  if (savingName.value || !nameChanged.value || nameProblem.value) return
  const submitted = name.value
  savingName.value = true
  try {
    const next = await api.updateProfile(submitted.trim())
    queryClient.setQueryData(ME_KEY, next)
    if (name.value === submitted) name.value = next.displayName
    // 实例的账号列表里也有显示名
    await queryClient.invalidateQueries({ queryKey: ['instance-accounts'] })
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    savingName.value = false
  }
}
const discardName = () => (name.value = savedName.value ?? '')

// 修改密码：当前密码、新密码与再输一次。失败的原因分开说；密码只在弹窗的局部状态里，关掉就清空
const passwordOpen = ref(false)
const passwords = reactive({ current: '', next: '', repeat: '' })
const passwordError = ref<string | null>(null)
const changing = ref(false)
const passwordProblem = computed(() => newPasswordProblem(passwords.next, passwords.repeat))
const canChange = computed(
  () => Boolean(passwords.current) && newPasswordReady(passwords.next, passwords.repeat),
)
function openPassword() {
  passwordOpen.value = true
}
function closePassword() {
  passwordOpen.value = false
  passwords.current = ''
  passwords.next = ''
  passwords.repeat = ''
  passwordError.value = null
}
async function changePassword() {
  if (changing.value || !canChange.value) return
  changing.value = true
  passwordError.value = null
  try {
    await api.changePassword({ currentPassword: passwords.current, newPassword: passwords.next })
    closePassword()
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
    toast.add({ title: '密码已修改', description: '其他设备需要重新登录。', color: 'success' })
  } catch (err) {
    passwordError.value = changePasswordError(err)
  } finally {
    changing.value = false
  }
}

// 登录设备：当前这个标出来；退出当前设备等于退出登录，走外壳的退出流程
const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: api.loginSessions })
const rows = computed(() => sessions.data.value?.sessions ?? [])
const others = computed(() => rows.value.filter((s) => !s.current).length)
const busy = ref<string | null>(null)

async function signOut(session: LoginSession) {
  if (session.current) {
    await logout()
    return
  }
  busy.value = session.id
  try {
    await api.signOutSession(session.id)
    toast.add({ title: '已退出该设备', color: 'success' })
  } catch (err) {
    // 已经不在了（过期、在那台设备上退出过）也算退出了
    if (!(err instanceof ApiError && err.status === 404)) {
      toast.add({ title: err instanceof ApiError ? err.message : '退出失败', color: 'error' })
    }
  } finally {
    busy.value = null
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
  }
}

async function signOutOthers() {
  busy.value = 'others'
  try {
    await api.signOutOtherSessions()
    toast.add({ title: '已退出其他设备', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '退出失败', color: 'error' })
  } finally {
    busy.value = null
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY })
  }
}
</script>

<template>
  <div>
    <SettingsBlock title="资料">
      <form @submit.prevent="saveName">
        <SettingsRow label="显示名" description="变更记录与成员列表里显示" for="profile-name">
          <UInput id="profile-name" v-model="name" :maxlength="64" class="w-60" />
        </SettingsRow>
        <SettingsRow label="用户名" description="用于登录，无法修改">
          <span class="mono">{{ me.data.value?.username }}</span>
        </SettingsRow>
        <SettingsRow label="密码" description="修改后其他设备需要重新登录">
          <UButton :icon="icons.password" color="neutral" variant="outline" @click="openPassword"
            >修改密码</UButton
          >
        </SettingsRow>
        <SaveBar
          :count="nameChanged ? 1 : 0"
          :saving="savingName"
          :problem="nameProblem"
          @discard="discardName"
        />
      </form>
    </SettingsBlock>

    <SettingsBlock title="登录设备" wide>
      <template #actions>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.logout"
          :disabled="others === 0"
          :loading="busy === 'others'"
          @click="signOutOthers"
          >退出其他设备</UButton
        >
      </template>
      <ReadFailureNote v-if="sessions.error.value" :query="sessions" fallback="登录设备读取失败" />
      <SettingsTable v-if="rows.length">
        <thead>
          <tr>
            <th>设备</th>
            <th>地址</th>
            <th>登录</th>
            <th>最近活动</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in rows" :key="session.id" :data-session="session.id">
            <td>
              <span :title="session.userAgent ?? undefined">{{
                deviceName(session.userAgent)
              }}</span>
              <FlagTag v-if="session.current" status="currentDevice" class="ml-2" />
            </td>
            <td class="mono">{{ session.clientAddress ?? '—' }}</td>
            <td>{{ formatShort(session.createdAt) }}</td>
            <td>{{ session.current ? '刚刚' : formatRelative(session.lastActiveAt) }}</td>
            <td class="text-right">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                :loading="busy === session.id"
                @click="signOut(session)"
                >退出</UButton
              >
            </td>
          </tr>
        </tbody>
      </SettingsTable>
    </SettingsBlock>

    <UModal
      :open="passwordOpen"
      title="修改密码"
      @update:open="(v) => (v ? openPassword() : closePassword())"
    >
      <template #body>
        <!-- 只有密码框，没有单选：回车提交就是点「修改」 -->
        <form id="change-password" class="space-y-4" @submit.prevent="changePassword">
          <input
            type="text"
            name="username"
            autocomplete="username"
            :value="me.data.value?.username"
            class="sr-only"
            tabindex="-1"
            aria-hidden="true"
            readonly
          />
          <UFormField label="当前密码">
            <UInput
              v-model="passwords.current"
              type="password"
              autocomplete="current-password"
              class="w-full"
            />
          </UFormField>
          <UFormField label="新密码" help="至少 10 位">
            <UInput
              v-model="passwords.next"
              type="password"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>
          <UFormField label="再输一次" :error="passwordProblem ?? undefined">
            <UInput
              v-model="passwords.repeat"
              type="password"
              autocomplete="new-password"
              class="w-full"
            />
          </UFormField>
          <p v-if="passwordError" class="text-error text-sm" role="alert">{{ passwordError }}</p>
        </form>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="closePassword">取消</UButton>
          <UButton type="submit" form="change-password" :loading="changing" :disabled="!canChange"
            >修改</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.mono {
  font-family: var(--font-mono);
  font-size: 13px;
}
</style>
