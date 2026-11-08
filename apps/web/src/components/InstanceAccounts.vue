<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { Username, type AccountLink, type AdminAccount } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref } from 'vue'

import {
  accountStates,
  accountStateText,
  latestRequest,
  SELF_LOCKED_REASON,
  SOLE_OWNER_TEXT,
  soleOwnerSpaces,
} from '../accounts'
import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { ME_KEY, useSession } from '../composables/useSession'
import { icons } from '../icons'
import { roleName } from '../settingsSections'
import { formatRelative } from '../time'
import Hint from './Hint.vue'
import PasswordLinkOnce from './PasswordLinkOnce.vue'
import EmptyState from './strata/EmptyState.vue'
import FlagTag from './strata/FlagTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 账号：新建账号（自动建个人空间，给设置密码链接）、重新生成链接、停用与启用、设为管理员。
// 链接只显示这一次，管理员不经手密码
const toast = useToast()
const queryClient = useQueryClient()
const { me } = useSession()
const QUERY_KEY = ['instance-accounts']
const accounts = useQuery({ queryKey: QUERY_KEY, queryFn: api.accounts })
const rows = computed(() => accounts.data.value?.accounts ?? [])
const selfId = computed(() => me.data.value?.id)

const initial = (account: AdminAccount) => Array.from(account.displayName)[0] ?? '?'

async function refresh(account?: AdminAccount) {
  // 新建账号会自动建个人空间：实例 › 空间那一节的列表一起刷新
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: ['instance-spaces'] }),
  ])
  // 改的是当前账号（显示名）时，顶栏与个人设置里的也跟着变
  if (account?.id === selfId.value) await queryClient.invalidateQueries({ queryKey: ME_KEY })
}

// 链接页显示的账号名一律取结果本身对应的账号，不取弹窗当前的目标
interface ShownLink {
  link: AccountLink
  displayName: string
}

// 新建账号：同一个弹窗，建好之后换成链接页。链接显示期间不能点遮罩、Esc 或右上角关掉，只能点「完成」。
// 请求期间可以取消：取消之后才回来的结果丢弃（latestRequest），不留到下一次打开
const createOpen = ref(false)
const form = reactive({ username: '', displayName: '', isAdmin: false })
const createError = ref<string | null>(null)
const creating = ref(false)
const created = ref<ShownLink | null>(null)
const createRequest = latestRequest()
const usernameProblem = computed(() => {
  if (!form.username) return null
  const parsed = Username.safeParse(form.username)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? '用户名格式错误')
})
const canCreate = computed(
  () => Boolean(form.username) && !usernameProblem.value && Boolean(form.displayName.trim()),
)
function resetCreate() {
  createRequest.reset()
  creating.value = false
  created.value = null
  createError.value = null
}
function openCreate() {
  resetCreate()
  createOpen.value = true
}
function closeCreate() {
  createOpen.value = false
  resetCreate()
  form.username = ''
  form.displayName = ''
  form.isAdmin = false
}
// 不用表单元素：建好之后同一个弹窗里显示链接，回车的隐式提交不能再建一个
async function create() {
  if (creating.value || !canCreate.value) return
  const ticket = createRequest.begin()
  creating.value = true
  createError.value = null
  try {
    const result = await api.createAccount({
      username: form.username,
      displayName: form.displayName.trim(),
      isAdmin: form.isAdmin,
    })
    if (createRequest.isCurrent(ticket)) {
      created.value = { link: result.link, displayName: result.account.displayName }
    }
    await refresh()
  } catch (err) {
    if (createRequest.isCurrent(ticket)) {
      createError.value = err instanceof ApiError ? err.message : '新建失败'
    }
  } finally {
    if (createRequest.isCurrent(ticket)) creating.value = false
  }
}

// 重新生成链接（重置密码也走它）：先确认，结果在同一个弹窗里显示一次。
// 请求期间关掉弹窗或换了账号，回来的结果丢弃：否则 A 的链接会在下一次打开时显示在 B 的名下
const linkTarget = ref<AdminAccount | null>(null)
const regenerated = ref<ShownLink | null>(null)
const regenerating = ref(false)
const linkRequest = latestRequest()
function openLink(account: AdminAccount) {
  linkRequest.reset()
  regenerating.value = false
  regenerated.value = null
  linkTarget.value = account
}
function closeLink() {
  linkRequest.reset()
  regenerating.value = false
  linkTarget.value = null
  regenerated.value = null
}
async function regenerate() {
  const target = linkTarget.value
  if (!target || regenerating.value) return
  const ticket = linkRequest.begin()
  regenerating.value = true
  try {
    const link = await api.regenerateAccountLink(target.id)
    if (linkRequest.isCurrent(ticket) && linkTarget.value?.id === target.id) {
      regenerated.value = { link, displayName: target.displayName }
    }
    await refresh()
  } catch (err) {
    if (linkRequest.isCurrent(ticket)) {
      toast.add({ title: err instanceof ApiError ? err.message : '生成失败', color: 'error' })
      closeLink()
    }
  } finally {
    if (linkRequest.isCurrent(ticket)) regenerating.value = false
  }
}

// 停用、启用、设为管理员与取消：先确认，写出后果
interface Confirmation {
  account: AdminAccount
  title: string
  body: string
  action: string
  danger: boolean
  change: { disabled?: boolean; isAdmin?: boolean }
  done: string
  // 停用时：他是唯一可用所有者的空间
  soleOwnerOf?: string[]
}
const confirming = ref<Confirmation | null>(null)
const applying = ref(false)
function askDisable(account: AdminAccount) {
  confirming.value = {
    account,
    title: `停用 ${account.displayName}？`,
    body: '停用后：无法登录，会话立即失效，其应用的访问密钥停止工作；重新启用后恢复。',
    action: '停用',
    danger: true,
    change: { disabled: true },
    done: '已停用',
    soleOwnerOf: soleOwnerSpaces(account),
  }
}
function askEnable(account: AdminAccount) {
  confirming.value = {
    account,
    title: `启用 ${account.displayName}？`,
    body: '启用后：可以重新登录，其应用的访问密钥恢复工作。',
    action: '启用',
    danger: false,
    change: { disabled: false },
    done: '已启用',
  }
}
function askAdmin(account: AdminAccount) {
  confirming.value = account.isAdmin
    ? {
        account,
        title: `取消 ${account.displayName} 的管理员身份？`,
        body: '取消后：无法再管理账号与实例设置。',
        action: '取消管理员',
        danger: true,
        change: { isAdmin: false },
        done: '已取消管理员',
      }
    : {
        account,
        title: `将 ${account.displayName} 设为管理员？`,
        body: '设为管理员后：可以管理全部账号与实例设置，包括模型、主密钥与备份。',
        action: '设为管理员',
        danger: false,
        change: { isAdmin: true },
        done: '已设为管理员',
      }
}
async function apply() {
  const c = confirming.value
  if (!c || applying.value) return
  applying.value = true
  try {
    await api.updateAccount(c.account.id, c.change)
    confirming.value = null
    toast.add({ title: c.done, color: 'success' })
  } catch (err) {
    // 保留最后一个管理员等规则由服务端说明
    toast.add({ title: err instanceof ApiError ? err.message : '修改失败', color: 'error' })
  } finally {
    applying.value = false
    await refresh(c.account)
  }
}
</script>

<template>
  <SettingsBlock title="全部账号" wide>
    <template #note>新账号获得一次性的设置密码链接，管理员不经手密码。</template>
    <template #actions>
      <UButton size="sm" :icon="icons.userPlus" @click="openCreate">新建账号</UButton>
    </template>
    <ReadFailureNote v-if="accounts.error.value" :query="accounts" fallback="账号读取失败" />
    <EmptyState v-else-if="accounts.isSuccess.value && !rows.length" title="暂无账号" />
    <SettingsTable v-if="rows.length">
      <thead>
        <tr>
          <th>账号</th>
          <th>管理员</th>
          <th>空间</th>
          <th>最近活动</th>
          <th>状态</th>
          <th><span class="sr-only">操作</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="account in rows" :key="account.id" :data-account="account.username">
          <td>
            <span class="who">
              <span class="avatar" aria-hidden="true">{{ initial(account) }}</span>
              <b>{{ account.displayName }}</b>
              <span class="mono">{{ account.username }}</span>
              <FlagTag v-if="account.id === selfId">当前账号</FlagTag>
            </span>
          </td>
          <td>
            <span v-if="account.isAdmin" class="admin" data-admin
              ><UIcon :name="icons.check" aria-hidden="true" />是</span
            >
            <span v-else class="dim">—</span>
          </td>
          <td>
            <span v-if="!account.spaces.length" class="dim">—</span>
            <span v-for="(s, i) in account.spaces" :key="s.id" class="space-item"
              >{{ i ? '、' : '' }}{{ s.name }} <span class="dim">{{ roleName(s.role) }}</span></span
            >
          </td>
          <td>
            <span v-if="account.disabledAt || !account.lastActiveAt" class="dim">—</span>
            <span v-else>{{ formatRelative(account.lastActiveAt) }}</span>
          </td>
          <td>
            <span class="states">
              <FlagTag
                v-for="state in accountStates(account)"
                :key="state.status"
                :status="state.status"
                :data-status="state.status"
                >{{ accountStateText(state) }}</FlagTag
              >
            </span>
          </td>
          <td>
            <span class="actions">
              <template v-if="account.disabledAt">
                <UButton size="xs" color="neutral" variant="ghost" @click="askEnable(account)"
                  >启用</UButton
                >
              </template>
              <template v-else>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.passwordLink"
                  @click="openLink(account)"
                  >{{ account.passwordSet ? '重置密码' : '重新生成链接' }}</UButton
                >
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :disabled="account.id === selfId"
                  data-action="admin"
                  @click="askAdmin(account)"
                  >{{ account.isAdmin ? '取消管理员' : '设为管理员' }}</UButton
                >
                <UButton
                  size="xs"
                  color="error"
                  variant="ghost"
                  :disabled="account.id === selfId"
                  data-action="disable"
                  @click="askDisable(account)"
                  >停用</UButton
                >
                <Hint v-if="account.id === selfId" label="无法修改的原因">{{
                  SELF_LOCKED_REASON
                }}</Hint>
              </template>
            </span>
          </td>
        </tr>
      </tbody>
    </SettingsTable>

    <UModal
      :open="createOpen"
      :title="created ? '设置密码链接' : '新建账号'"
      :dismissible="!created"
      :close="!created"
      @update:open="(v) => (v ? openCreate() : closeCreate())"
    >
      <template #body>
        <PasswordLinkOnce v-if="created" :link="created.link" :display-name="created.displayName" />
        <div v-else class="space-y-4">
          <UFormField
            label="用户名"
            help="用于登录，小写字母、数字与 _.-，建好后无法修改"
            :error="usernameProblem ?? undefined"
          >
            <UInput v-model="form.username" autocomplete="off" class="w-full" />
          </UFormField>
          <UFormField label="显示名">
            <UInput v-model="form.displayName" :maxlength="64" class="w-full" />
          </UFormField>
          <UCheckbox
            v-model="form.isAdmin"
            label="设为管理员"
            description="可以管理全部账号与实例设置"
          />
          <p class="dim text-sm">
            同时建立个人空间「{{ form.displayName.trim() || '显示名' }}的空间」，本人是所有者。
          </p>
          <p v-if="createError" class="text-error text-sm" role="alert">{{ createError }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="created" @click="closeCreate">完成</UButton>
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="closeCreate">取消</UButton>
            <UButton :loading="creating" :disabled="!canCreate" @click="create">新建</UButton>
          </template>
        </div>
      </template>
    </UModal>

    <UModal
      :open="linkTarget !== null"
      :title="
        regenerated ? '设置密码链接' : linkTarget?.passwordSet ? '重置密码？' : '重新生成链接？'
      "
      :dismissible="!regenerated"
      :close="!regenerated"
      @update:open="(v) => !v && closeLink()"
    >
      <template #body>
        <PasswordLinkOnce
          v-if="regenerated"
          :link="regenerated.link"
          :display-name="regenerated.displayName"
        />
        <p v-else class="text-sm">
          生成新的设置密码链接后：之前的链接失效{{
            linkTarget?.passwordSet ? '；链接使用前，当前密码仍然有效' : ''
          }}。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="regenerated" @click="closeLink">完成</UButton>
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="closeLink">取消</UButton>
            <UButton :loading="regenerating" @click="regenerate">生成链接</UButton>
          </template>
        </div>
      </template>
    </UModal>

    <UModal
      :open="confirming !== null"
      :title="confirming?.title"
      @update:open="(v) => !v && (confirming = null)"
    >
      <template #body>
        <p class="text-sm">{{ confirming?.body }}</p>
        <div v-if="confirming?.soleOwnerOf?.length" class="mt-3 text-sm" data-sole-owner>
          <p class="text-warning">
            唯一可用的所有者：{{ confirming.soleOwnerOf.map((n) => `「${n}」`).join('、') }}
          </p>
          <p class="mt-1">{{ SOLE_OWNER_TEXT }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirming = null">取消</UButton>
          <UButton
            :color="confirming?.danger ? 'error' : 'primary'"
            :loading="applying"
            @click="apply"
            >{{ confirming?.action }}</UButton
          >
        </div>
      </template>
    </UModal>
  </SettingsBlock>
</template>

<style scoped>
.who {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--strata-rule);
  font-size: 12px;
}
.mono {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.dim {
  color: var(--ui-text-muted);
}
.admin {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
/* 窄屏时一个空间名不拆开，表格横向滚动 */
.space-item {
  white-space: nowrap;
}
.states {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}
.actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  width: 100%;
  white-space: nowrap;
}
</style>
