<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useAfterSpaceGone, useLeaveSpace } from '../composables/useLeaveSpace'
import { useSession } from '../composables/useSession'
import { roleName } from '../settingsSections'
import {
  isLastOwner,
  LAST_OWNER_NOTE,
  LEAVE_CONSEQUENCES,
  LEAVE_NOTE,
  refreshSpaces,
  TRANSFER_CONSEQUENCES,
  transferTargets,
} from '../spaces'
import { localDate } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import DangerZone from './DangerZone.vue'
import DeleteSpaceModal from './DeleteSpaceModal.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'

// 空间 › 概况：名称（空间所有者可改）、当前账号的角色、成员数与建立时间；下面是危险操作：转让所有者、离开空间、删除空间。
// 空间组只挂在空间的地址下，空间取地址里的；不是成员时外壳不渲染这一页
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { me, space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const myId = computed(() => me.data.value?.id)
const isOwner = computed(() => space.value?.role === 'owner')
const isAdmin = computed(() => me.data.value?.isAdmin ?? false)

const detail = useQuery({
  queryKey: computed(() => ['space', spaceId.value]),
  queryFn: () => api.space(spaceId.value),
})
const members = useQuery({
  queryKey: computed(() => ['members', spaceId.value]),
  queryFn: () => api.members(spaceId.value),
})

// 名称：基准是服务端最新的名字，没改过时跟着它
const savedName = computed(() => detail.data.value?.name)
const name = ref(savedName.value ?? '')
const baseline = ref(savedName.value)
watch(savedName, (next) => {
  if (next === undefined) return
  if (name.value === baseline.value) name.value = next
  baseline.value = next
})
const changed = computed(() => baseline.value !== undefined && name.value.trim() !== baseline.value)
const problem = computed(() => {
  if (!changed.value) return null
  const v = name.value.trim()
  if (!v) return '名称：未填写'
  return v.length > 64 ? '名称：超出长度' : null
})
watch(changed, (d) => (dirtyModel.value = d), { immediate: true })
const saving = ref(false)
async function save() {
  if (saving.value || !changed.value || problem.value) return
  const submitted = name.value.trim()
  saving.value = true
  try {
    const saved = await api.renameSpace(spaceId.value, submitted)
    if (name.value.trim() === submitted) name.value = saved.name
    baseline.value = saved.name
    await refreshSpaces(queryClient, spaceId.value)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
const discard = () => (name.value = baseline.value ?? '')

// 转让所有者：选一个别的成员
const list = computed(() => members.data.value ?? [])
const targets = computed(() =>
  myId.value
    ? transferTargets(list.value, myId.value).map((m) => ({
        label: `${m.displayName}（${m.username}）· ${roleName(m.role)}`,
        value: m.accountId,
      }))
    : [],
)
const transferOpen = ref(false)
const transferTo = ref<string | undefined>()
const transferBusy = ref(false)
const transferError = ref<string | null>(null)
function startTransfer() {
  transferTo.value = undefined
  transferError.value = null
  transferOpen.value = true
}
async function transfer() {
  if (!transferTo.value || transferBusy.value) return
  transferBusy.value = true
  transferError.value = null
  try {
    await api.transferOwnership(spaceId.value, transferTo.value)
    transferOpen.value = false
    await refreshSpaces(queryClient, spaceId.value)
    toast.add({ title: '已转让所有者', color: 'success' })
  } catch (err) {
    transferError.value = err instanceof ApiError ? err.message : '转让失败'
  } finally {
    transferBusy.value = false
  }
}

const lastOwner = computed(() => Boolean(myId.value && isLastOwner(list.value, myId.value)))
const leave = useLeaveSpace(spaceId, myId)

const deleteOpen = ref(false)
const afterGone = useAfterSpaceGone()
async function deleted() {
  deleteOpen.value = false
  toast.add({ title: '已删除空间', color: 'success' })
  await afterGone(spaceId.value)
}
</script>

<template>
  <div>
    <SettingsBlock title="空间">
      <ReadFailureNote v-if="detail.isError.value" :query="detail" />
      <USkeleton v-if="detail.isPending.value" class="h-40 w-full" />
      <template v-else-if="detail.data.value">
        <form v-if="isOwner" @submit.prevent="save">
          <SettingsRow label="名称" description="空间切换器与成员看到的名字" for="space-name">
            <UInput id="space-name" v-model="name" class="w-full max-w-xs" autocomplete="off" />
            <p v-if="problem" class="w-full text-xs text-error">请填写 1 到 64 个字符。</p>
          </SettingsRow>
          <SaveBar
            :count="changed ? 1 : 0"
            :saving="saving"
            :problem="problem"
            @discard="discard"
          />
        </form>
        <SettingsRow v-else label="名称">{{ detail.data.value.name }}</SettingsRow>
        <SettingsRow label="当前账号的角色">{{ roleName(detail.data.value.role) }}</SettingsRow>
        <SettingsRow label="成员">
          <span class="tabular-nums">{{ detail.data.value.memberCount }}</span> 个
        </SettingsRow>
        <SettingsRow label="建立时间">{{
          localDate(new Date(detail.data.value.createdAt))
        }}</SettingsRow>
      </template>
    </SettingsBlock>

    <DangerZone v-if="detail.data.value">
      <div v-if="isOwner" class="danger-row">
        <div class="danger-text">
          <p class="danger-name">转让所有者</p>
          <p class="danger-note">对方成为所有者，当前账号改为编辑者。</p>
        </div>
        <UButton
          color="neutral"
          variant="outline"
          :disabled="!targets.length"
          :title="targets.length ? undefined : '暂无其他成员'"
          @click="startTransfer"
          >转让所有者</UButton
        >
      </div>
      <div class="danger-row">
        <div class="danger-text">
          <p class="danger-name">离开空间</p>
          <p class="danger-note">
            {{ lastOwner ? LAST_OWNER_NOTE : LEAVE_NOTE }}
          </p>
        </div>
        <UButton color="error" variant="outline" :disabled="lastOwner" @click="leave.start"
          >离开空间</UButton
        >
      </div>
      <div v-if="isOwner || isAdmin" class="danger-row">
        <div class="danger-text">
          <p class="danger-name">删除空间</p>
          <p class="danger-note">空间内的记忆、凭据与访问密钥全部删除，接入的应用立即失去访问。</p>
        </div>
        <UButton color="error" @click="deleteOpen = true">删除空间</UButton>
      </div>
    </DangerZone>

    <ConsequenceModal
      :open="transferOpen"
      title="转让所有者"
      :consequences="TRANSFER_CONSEQUENCES"
      action="转让"
      :busy="transferBusy"
      :error="transferError"
      :disabled="!transferTo"
      @confirm="transfer"
      @close="transferOpen = false"
    >
      <UFormField label="新所有者">
        <USelect v-model="transferTo" :items="targets" placeholder="选择成员" class="w-full" />
      </UFormField>
    </ConsequenceModal>
    <ConsequenceModal
      :open="leave.open.value"
      :title="`离开空间「${detail.data.value?.name ?? ''}」`"
      :consequences="LEAVE_CONSEQUENCES"
      action="离开空间"
      :busy="leave.busy.value"
      :error="leave.error.value"
      @confirm="leave.confirm"
      @close="leave.open.value = false"
    />
    <DeleteSpaceModal
      :open="deleteOpen"
      :space-id="spaceId"
      :space-name="detail.data.value?.name ?? ''"
      can-export
      @close="deleteOpen = false"
      @deleted="deleted"
    />
  </div>
</template>
