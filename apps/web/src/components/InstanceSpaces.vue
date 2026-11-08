<script setup lang="ts">
import type { CreatedSpace, InstanceSpace } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { refreshSpaces } from '../spaces'
import { localDate } from '../time'
import CreateSpaceModal from './CreateSpaceModal.vue'
import DeleteSpaceModal from './DeleteSpaceModal.vue'
import SpaceImport from './SpaceImport.vue'
import EmptyState from './strata/EmptyState.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 空间：实例里的全部空间（不含内容）、新建空间（选所有者）、「允许成员自建空间」，下面是导入空间
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const router = useRouter()
const queryClient = useQueryClient()
const { me } = useSession()
const myId = computed(() => me.data.value?.id ?? '')
const memberOf = (spaceId: string) => (me.data.value?.spaces ?? []).some((s) => s.id === spaceId)

const spaces = useQuery({ queryKey: ['instance-spaces'], queryFn: api.instanceSpaces })
const policy = useQuery({ queryKey: ['space-creation'], queryFn: api.spaceCreation })

// 开关：基准是服务端最新的值，没改过时跟着它
const saved = computed(() => policy.data.value?.membersCanCreate)
const allow = ref(saved.value ?? false)
const baseline = ref(saved.value)
watch(saved, (next) => {
  if (next === undefined) return
  if (allow.value === baseline.value) allow.value = next
  baseline.value = next
})
const changed = computed(() => baseline.value !== undefined && allow.value !== baseline.value)
watch(changed, (d) => (dirtyModel.value = d), { immediate: true })
const saving = ref(false)
async function save() {
  if (saving.value || !changed.value) return
  const submitted = allow.value
  saving.value = true
  try {
    const view = await api.saveSpaceCreation(submitted)
    if (allow.value === submitted) allow.value = view.membersCanCreate
    baseline.value = view.membersCanCreate
    queryClient.setQueryData(['space-creation'], view)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
const discard = () => (allow.value = baseline.value ?? false)

const creating = ref(false)
async function created(space: CreatedSpace) {
  creating.value = false
  await refreshSpaces(queryClient)
  toast.add({ title: `已新建空间「${space.name}」`, color: 'success' })
}

const deleting = ref<InstanceSpace | null>(null)
async function deleted() {
  const gone = deleting.value
  deleting.value = null
  await refreshSpaces(queryClient, gone?.id)
  toast.add({ title: `已删除空间「${gone?.name ?? ''}」`, color: 'success' })
}
const owners = (space: InstanceSpace) => space.owners.map((o) => o.displayName).join('、') || '—'
const open = (space: InstanceSpace) =>
  void router.push({ name: 'overview', params: { spaceId: space.id } })
</script>

<template>
  <div>
    <SettingsBlock title="空间列表" wide>
      <template #actions>
        <UButton :icon="icons.add" size="sm" @click="creating = true">新建空间</UButton>
      </template>
      <ReadFailureNote v-if="spaces.isError.value" :query="spaces" />
      <USkeleton v-if="spaces.isPending.value" class="h-32 w-full" />
      <EmptyState
        v-else-if="spaces.isSuccess.value && !spaces.data.value?.length"
        title="暂无空间"
        description="新建空间后指定所有者，所有者再添加成员。"
      />
      <SettingsTable v-else-if="spaces.data.value?.length">
        <thead>
          <tr>
            <th>名称</th>
            <th>所有者</th>
            <th class="num">成员</th>
            <th>建立时间</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in spaces.data.value" :key="s.id">
            <td>
              <button v-if="memberOf(s.id)" type="button" class="underline" @click="open(s)">
                {{ s.name }}
              </button>
              <span v-else>{{ s.name }}</span>
            </td>
            <td>{{ owners(s) }}</td>
            <td class="num">{{ s.memberCount }}</td>
            <td>{{ localDate(new Date(s.createdAt)) }}</td>
            <td class="text-right">
              <UButton size="sm" color="error" variant="ghost" @click="deleting = s">删除</UButton>
            </td>
          </tr>
        </tbody>
      </SettingsTable>
    </SettingsBlock>

    <SettingsBlock title="新建空间的权限">
      <ReadFailureNote v-if="policy.isError.value" :query="policy" />
      <form v-if="policy.data.value" @submit.prevent="save">
        <SettingsRow
          label="允许成员自建空间"
          description="关闭时只有实例管理员能新建空间"
          for="allow-member-spaces"
        >
          <USwitch id="allow-member-spaces" v-model="allow" />
        </SettingsRow>
        <SaveBar :count="changed ? 1 : 0" :saving="saving" @discard="discard" />
      </form>
    </SettingsBlock>

    <SpaceImport />

    <CreateSpaceModal
      :open="creating"
      :current-account-id="myId"
      choose-owner
      @close="creating = false"
      @created="created"
    />
    <DeleteSpaceModal
      :open="deleting !== null"
      :space-id="deleting?.id ?? ''"
      :space-name="deleting?.name ?? ''"
      :can-export="deleting ? memberOf(deleting.id) : false"
      @close="deleting = null"
      @deleted="deleted"
    />
  </div>
</template>
