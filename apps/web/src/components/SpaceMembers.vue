<script setup lang="ts">
import { MEMBER_ROLES, type MemberRole, type SpaceMember } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useLeaveSpace } from '../composables/useLeaveSpace'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { roleName } from '../settingsSections'
import {
  initialOf,
  isLastOwner,
  LAST_OWNER_NOTE,
  LEAVE_CONSEQUENCES,
  memberAction,
  refreshSpaces,
  REMOVE_CONSEQUENCES,
  roleEditable,
} from '../spaces'
import { localDate } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import EmptyState from './strata/EmptyState.vue'
import FlagTag from './strata/FlagTag.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 空间 › 成员：所有者按用户名添加成员；成员表（角色只有所有者能改别人的）、移除与离开；角色与权限的说明。
// 别人的本人记忆、凭据的数量都不显示，只显示应用数
const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const myId = computed(() => me.data.value?.id)
const isOwner = computed(() => space.value?.role === 'owner')
const viewer = computed(() => ({
  accountId: myId.value ?? '',
  role: space.value?.role ?? ('viewer' as MemberRole),
}))

const members = useQuery({
  queryKey: computed(() => ['members', spaceId.value]),
  queryFn: () => api.members(spaceId.value),
})
const list = computed(() => members.data.value ?? [])

const roleItems = MEMBER_ROLES.map((role) => ({ label: roleName(role), value: role }))

// 添加成员：用户名与角色。账号不存在、已是成员、账号已停用这类原因写在表单下面
const username = ref('')
const newRole = ref<MemberRole>('editor')
const adding = ref(false)
const addError = ref<string | null>(null)
// 改了用户名或角色，上一次的原因就不再适用
watch([username, newRole], () => (addError.value = null))
async function add() {
  const name = username.value.trim()
  if (!name || adding.value) return
  adding.value = true
  addError.value = null
  try {
    const added = await api.addMember(spaceId.value, { username: name, role: newRole.value })
    username.value = ''
    await refreshSpaces(queryClient, spaceId.value)
    toast.add({ title: `已添加 ${added.displayName}`, color: 'success' })
  } catch (err) {
    addError.value = err instanceof ApiError ? err.message : '添加失败'
  } finally {
    adding.value = false
  }
}

// 改角色：失败（例如空间至少要有一个所有者）时用 toast 说明，下拉回到原来的角色
const changing = ref<string | null>(null)
async function changeRole(row: SpaceMember, role: MemberRole) {
  if (role === row.role || changing.value) return
  changing.value = row.accountId
  try {
    await api.updateMember(spaceId.value, row.accountId, role)
    toast.add({ title: `${row.displayName} 已改为${roleName(role)}`, color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '修改失败', color: 'error' })
  } finally {
    changing.value = null
    await refreshSpaces(queryClient, spaceId.value)
  }
}

// 移除别人
const removing = ref<SpaceMember | null>(null)
const removeBusy = ref(false)
const removeError = ref<string | null>(null)
function startRemove(row: SpaceMember) {
  removeError.value = null
  removing.value = row
}
async function remove() {
  const row = removing.value
  if (!row || removeBusy.value) return
  removeBusy.value = true
  removeError.value = null
  try {
    await api.removeMember(spaceId.value, row.accountId)
    removing.value = null
    await refreshSpaces(queryClient, spaceId.value)
    toast.add({ title: `已移除 ${row.displayName}`, color: 'success' })
  } catch (err) {
    removeError.value = err instanceof ApiError ? err.message : '移除失败'
  } finally {
    removeBusy.value = false
  }
}

const leave = useLeaveSpace(spaceId, myId)
const actionOf = (row: SpaceMember) => memberAction(viewer.value, row, list.value)
// 当前账号是唯一的所有者时，表格下面写出为什么不能离开
const selfBlocked = computed(() =>
  myId.value && isLastOwner(list.value, myId.value) ? LAST_OWNER_NOTE : null,
)

// 角色与权限：和服务端的角色上限一致（见设计文档「账号」）
const CAPABILITIES: { label: string; owner: string; editor: string; viewer: string }[] = [
  { label: '读记忆', owner: '✓', editor: '✓', viewer: '✓' },
  { label: '写记忆', owner: '至机密', editor: '至私密', viewer: '—' },
  { label: '应用与访问密钥', owner: '全部应用（他人的仅吊销）', editor: '自己的应用', viewer: '—' },
  { label: '凭据与密码库', owner: '✓', editor: '只看自己的列表', viewer: '—' },
  { label: '成员、空间设置、导出', owner: '✓', editor: '—', viewer: '—' },
]
</script>

<template>
  <div>
    <SettingsBlock title="成员列表" wide>
      <template #note>本人记忆按成员各自存放，其他成员不可见。</template>

      <div v-if="isOwner" class="add-member">
        <UInput
          v-model="username"
          placeholder="用户名"
          aria-label="用户名"
          class="w-48"
          autocomplete="off"
          :disabled="adding"
          @keydown.enter.prevent="add"
        />
        <USelect v-model="newRole" :items="roleItems" aria-label="角色" class="w-28" />
        <UButton :icon="icons.add" :loading="adding" :disabled="!username.trim()" @click="add"
          >添加成员</UButton
        >
        <p v-if="addError" class="w-full text-sm text-error" role="alert">{{ addError }}</p>
      </div>

      <ReadFailureNote v-if="members.isError.value" :query="members" />
      <USkeleton v-if="members.isPending.value" class="h-32 w-full" />
      <EmptyState v-else-if="members.isSuccess.value && !list.length" title="暂无成员" />
      <SettingsTable v-else-if="list.length">
        <thead>
          <tr>
            <th>成员</th>
            <th>角色</th>
            <th class="num">应用</th>
            <th>加入时间</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in list" :key="row.accountId">
            <td>
              <span class="who">
                <span class="avatar" aria-hidden="true">{{ initialOf(row.displayName) }}</span>
                <span class="who-name">{{ row.displayName }}</span>
                <span class="font-mono text-xs text-muted">{{ row.username }}</span>
                <FlagTag v-if="row.accountId === myId">当前账号</FlagTag>
              </span>
            </td>
            <td>
              <USelect
                v-if="roleEditable(viewer, row)"
                :model-value="row.role"
                :items="roleItems"
                size="sm"
                class="w-28"
                :aria-label="`${row.displayName} 的角色`"
                :loading="changing === row.accountId"
                :disabled="changing !== null"
                @update:model-value="(v) => changeRole(row, v as MemberRole)"
              />
              <span v-else>{{ roleName(row.role) }}</span>
            </td>
            <td class="num">{{ row.appCount }}</td>
            <td>{{ localDate(new Date(row.joinedAt)) }}</td>
            <td class="actions">
              <template v-if="actionOf(row)">
                <UButton
                  size="sm"
                  color="error"
                  variant="ghost"
                  :disabled="Boolean(actionOf(row)!.blocked)"
                  :title="actionOf(row)!.blocked ?? undefined"
                  @click="actionOf(row)!.kind === 'leave' ? leave.start() : startRemove(row)"
                  >{{ actionOf(row)!.kind === 'leave' ? '离开' : '移除' }}</UButton
                >
              </template>
            </td>
          </tr>
        </tbody>
      </SettingsTable>
      <p v-if="selfBlocked" class="pt-2 text-xs text-muted">{{ selfBlocked }}</p>
    </SettingsBlock>

    <SettingsBlock title="角色与权限" wide>
      <details class="capabilities">
        <summary>各角色能做什么</summary>
        <SettingsTable>
          <thead>
            <tr>
              <th>能力</th>
              <th>所有者</th>
              <th>编辑者</th>
              <th>查看者</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in CAPABILITIES" :key="c.label">
              <td>{{ c.label }}</td>
              <td>{{ c.owner }}</td>
              <td :class="{ 'text-muted': c.editor === '—' }">{{ c.editor }}</td>
              <td :class="{ 'text-muted': c.viewer === '—' }">{{ c.viewer }}</td>
            </tr>
          </tbody>
        </SettingsTable>
      </details>
    </SettingsBlock>

    <ConsequenceModal
      :open="removing !== null"
      :title="`移除成员「${removing?.displayName ?? ''}」`"
      :consequences="REMOVE_CONSEQUENCES"
      action="移除成员"
      :busy="removeBusy"
      :error="removeError"
      @confirm="remove"
      @close="removing = null"
    />
    <ConsequenceModal
      :open="leave.open.value"
      :title="`离开空间「${space?.name ?? ''}」`"
      :consequences="LEAVE_CONSEQUENCES"
      action="离开空间"
      :busy="leave.busy.value"
      :error="leave.error.value"
      @confirm="leave.confirm"
      @close="leave.open.value = false"
    />
  </div>
</template>

<style scoped>
.add-member {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.who {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.who-name {
  font-weight: 500;
}
.avatar {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  background: var(--ui-bg-accented);
  font-size: 12px;
  color: var(--ui-text-highlighted);
}
.actions {
  text-align: right;
}
.capabilities summary {
  cursor: pointer;
  padding-bottom: 8px;
  color: var(--ui-text-muted);
}
</style>
