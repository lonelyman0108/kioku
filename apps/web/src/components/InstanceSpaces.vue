<script setup lang="ts">
import {
  MaxOwnedSpaces,
  SPACE_LIMIT_MAX,
  SPACE_LIMIT_MIN,
  type InstanceSpace,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSpaceLimit } from '../composables/useCreateSpace'
import { useAfterSpaceGone } from '../composables/useLeaveSpace'
import { fieldProblems, useSavedField } from '../composables/useSavedField'
import { useSession } from '../composables/useSession'
import { SPACE_LIMIT_KEY } from '../spaces'
import { localDate } from '../time'
import DeleteSpaceModal from './DeleteSpaceModal.vue'
import Hint from './Hint.vue'
import EmptyState from './strata/EmptyState.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 空间：空间数量上限，和实例里的全部空间（不含内容，只能删除）。新建与导入在空间切换器里，各账号自己做
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const router = useRouter()
const queryClient = useQueryClient()
const { me } = useSession()
const memberOf = (spaceId: string) => (me.data.value?.spaces ?? []).some((s) => s.id === spaceId)
// 导出只给空间所有者：不是所有者的实例管理员删除前要请所有者导出
const ownerOf = (spaceId: string) =>
  (me.data.value?.spaces ?? []).some((s) => s.id === spaceId && s.role === 'owner')
const afterGone = useAfterSpaceGone()

const spaces = useQuery({ queryKey: ['instance-spaces'], queryFn: api.instanceSpaces })
// 和入口用的是同一个查询：改完上限，入口的可用与否跟着变
const { limit } = useSpaceLimit()

const max = useSavedField(() => limit.data.value?.maxOwnedSpaces, {
  min: SPACE_LIMIT_MIN,
  max: SPACE_LIMIT_MAX,
  schema: MaxOwnedSpaces,
})
const problem = computed(() => fieldProblems([{ label: '空间数量上限', issue: max.issue.value }]))
watch(max.changed, (d) => (dirtyModel.value = d), { immediate: true })
const saving = ref(false)
async function save() {
  if (saving.value || !max.changed.value || problem.value) return
  const submitted = max.value.value
  if (typeof submitted !== 'number') return
  saving.value = true
  try {
    const view = await api.saveSpaceLimit(submitted)
    max.commit(submitted, view.maxOwnedSpaces)
    queryClient.setQueryData(SPACE_LIMIT_KEY, view)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const deleting = ref<InstanceSpace | null>(null)
async function deleted() {
  const gone = deleting.value
  deleting.value = null
  if (gone) await afterGone(gone.id)
  toast.add({ title: `已删除空间「${gone?.name ?? ''}」`, color: 'success' })
}
const owners = (space: InstanceSpace) => space.owners.map((o) => o.displayName).join('、') || '—'
const open = (space: InstanceSpace) =>
  void router.push({ name: 'overview', params: { spaceId: space.id } })
</script>

<template>
  <div>
    <SettingsBlock title="空间数量">
      <template #note>
        每个账号可新建、导入空间，数量受此上限约束。
        <Hint>
          <p>
            按账号作为所有者的空间计数，实例管理员同样适用。新建、导入、接受转让与成为所有者各占一个，新账号自带的个人空间计入。
          </p>
          <p class="mt-1">调低后已超出的账号保留现有空间，减少到上限以下才能再新建。</p>
        </Hint>
      </template>
      <ReadFailureNote v-if="limit.isError.value" :query="limit" />
      <USkeleton v-if="limit.isPending.value" class="h-14 w-full" />
      <form v-else-if="limit.data.value" @submit.prevent="save">
        <SettingsRow label="空间数量上限" description="每个账号最多拥有的空间" for="space-limit">
          <UInputNumber
            id="space-limit"
            v-model="max.value.value"
            :min="SPACE_LIMIT_MIN"
            :max="SPACE_LIMIT_MAX"
            class="w-32"
            :aria-describedby="max.invalid.value ? 'space-limit-range' : undefined"
          />
          <span class="text-xs text-muted">个</span>
          <p
            v-if="max.invalid.value"
            id="space-limit-range"
            class="w-full text-xs text-error"
            role="alert"
          >
            请填写 {{ SPACE_LIMIT_MIN }} 到 {{ SPACE_LIMIT_MAX }} 之间的整数。
          </p>
        </SettingsRow>
        <SaveBar
          :count="max.changed.value ? 1 : 0"
          :saving="saving"
          :problem="problem"
          @discard="max.reset()"
        />
      </form>
    </SettingsBlock>

    <SettingsBlock title="空间列表" wide>
      <ReadFailureNote v-if="spaces.isError.value" :query="spaces" />
      <USkeleton v-if="spaces.isPending.value" class="h-32 w-full" />
      <EmptyState
        v-else-if="spaces.isSuccess.value && !spaces.data.value?.length"
        title="暂无空间"
        description="各账号在空间切换器中新建或导入空间。"
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

    <DeleteSpaceModal
      :open="deleting !== null"
      :space-id="deleting?.id ?? ''"
      :space-name="deleting?.name ?? ''"
      :can-export="deleting ? ownerOf(deleting.id) : false"
      @close="deleting = null"
      @deleted="deleted"
    />
  </div>
</template>
