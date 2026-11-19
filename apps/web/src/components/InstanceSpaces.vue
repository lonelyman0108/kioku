<script setup lang="ts">
import {
  CIRCLE_LIMIT_MAX,
  CIRCLE_LIMIT_MIN,
  MaxOwnedCircles,
  type AdminCircle,
} from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCircleLimit } from '../composables/useCreateSpace'
import { useAfterCircleGone } from '../composables/useLeaveSpace'
import { fieldProblems, useSavedField } from '../composables/useSavedField'
import { useSession } from '../composables/useSession'
import { circleKindLabels } from '../labels'
import { CIRCLE_LIMIT_KEY } from '../spaces'
import { localDate } from '../time'
import DeleteSpaceModal from './DeleteSpaceModal.vue'
import Hint from './Hint.vue'
import EmptyState from './strata/EmptyState.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SaveBar from './strata/SaveBar.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsRow from './strata/SettingsRow.vue'
import SettingsTable from './strata/SettingsTable.vue'

// 实例 › 记忆圈：共享记忆圈数量上限，和实例里的全部记忆圈（不含内容，仅共享圈可删除）。新建与导入在记忆圈切换器里，各账号自己做
const dirtyModel = defineModel<boolean>('dirty', { default: false })
const toast = useToast()
const router = useRouter()
const queryClient = useQueryClient()
const { me } = useSession()
const memberOf = (circleId: string) => (me.data.value?.circles ?? []).some((c) => c.id === circleId)
// 导出只给记忆圈所有者：不是所有者的实例管理员删除前要请所有者导出
const ownerOf = (circleId: string) =>
  (me.data.value?.circles ?? []).some((c) => c.id === circleId && c.role === 'owner')
const afterGone = useAfterCircleGone()

const circles = useQuery({ queryKey: ['instance-circles'], queryFn: api.instanceCircles })
// 和入口用的是同一个查询：改完上限，入口的可用与否跟着变
const { limit } = useCircleLimit()

const max = useSavedField(() => limit.data.value?.maxOwnedCircles, {
  min: CIRCLE_LIMIT_MIN,
  max: CIRCLE_LIMIT_MAX,
  schema: MaxOwnedCircles,
})
const problem = computed(() => fieldProblems([{ label: '共享圈数量上限', issue: max.issue.value }]))
watch(max.changed, (d) => (dirtyModel.value = d), { immediate: true })
const saving = ref(false)
async function save() {
  if (saving.value || !max.changed.value || problem.value) return
  const submitted = max.value.value
  if (typeof submitted !== 'number') return
  saving.value = true
  try {
    const view = await api.saveCircleLimit(submitted)
    max.commit(submitted, view.maxOwnedCircles)
    queryClient.setQueryData(CIRCLE_LIMIT_KEY, view)
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const deleting = ref<AdminCircle | null>(null)
async function deleted() {
  const gone = deleting.value
  deleting.value = null
  if (gone) await afterGone(gone.id)
  toast.add({ title: `已删除共享圈「${gone?.name ?? ''}」`, color: 'success' })
}
const owners = (c: AdminCircle) => c.owners.map((o) => o.displayName).join('、') || '—'
const open = (c: AdminCircle) => void router.push({ name: 'overview', params: { circleId: c.id } })
</script>

<template>
  <div>
    <SettingsBlock title="共享记忆圈数量">
      <template #note>
        每个账号可新建、导入共享记忆圈，数量受此上限约束；个人圈不占配额。
        <Hint>
          <p>
            按账号作为所有者的共享记忆圈计数，实例管理员同样适用。新建共享圈、导入为新共享圈与接受所有者转让各占一个。
          </p>
          <p class="mt-1">调低后已超出的账号保留现有共享圈，减少到上限以下才能再新建。</p>
        </Hint>
      </template>
      <ReadFailureNote v-if="limit.isError.value" :query="limit" />
      <USkeleton v-if="limit.isPending.value" class="h-14 w-full" />
      <form v-else-if="limit.data.value" @submit.prevent="save">
        <SettingsRow
          label="共享圈数量上限"
          description="每个账号最多拥有的共享圈"
          for="circle-limit"
        >
          <UInputNumber
            id="circle-limit"
            v-model="max.value.value"
            :min="CIRCLE_LIMIT_MIN"
            :max="CIRCLE_LIMIT_MAX"
            class="w-32"
            :aria-describedby="max.invalid.value ? 'circle-limit-range' : undefined"
          />
          <span class="text-xs text-muted">个</span>
          <p
            v-if="max.invalid.value"
            id="circle-limit-range"
            class="w-full text-xs text-error"
            role="alert"
          >
            请填写 {{ CIRCLE_LIMIT_MIN }} 到 {{ CIRCLE_LIMIT_MAX }} 之间的整数。
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

    <SettingsBlock title="记忆圈列表" wide>
      <ReadFailureNote v-if="circles.isError.value" :query="circles" />
      <USkeleton v-if="circles.isPending.value" class="h-32 w-full" />
      <EmptyState
        v-else-if="circles.isSuccess.value && !circles.data.value?.length"
        title="暂无记忆圈"
        description="各账号在记忆圈切换器中新建共享圈或导入记忆圈。"
      />
      <SettingsTable v-else-if="circles.data.value?.length">
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>所有者</th>
            <th class="num">成员</th>
            <th>建立时间</th>
            <th><span class="sr-only">操作</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in circles.data.value" :key="c.id">
            <td>
              <button v-if="memberOf(c.id)" type="button" class="underline" @click="open(c)">
                {{ c.name }}
              </button>
              <span v-else>{{ c.name }}</span>
            </td>
            <td>{{ circleKindLabels[c.kind] }}</td>
            <td>{{ owners(c) }}</td>
            <td class="num">{{ c.memberCount }}</td>
            <td>{{ localDate(new Date(c.createdAt)) }}</td>
            <td class="text-right">
              <UButton
                v-if="c.kind === 'shared'"
                size="sm"
                color="error"
                variant="ghost"
                @click="deleting = c"
                >删除</UButton
              >
            </td>
          </tr>
        </tbody>
      </SettingsTable>
    </SettingsBlock>

    <DeleteSpaceModal
      :open="deleting !== null"
      :circle-id="deleting?.id ?? ''"
      :circle-name="deleting?.name ?? ''"
      :can-export="deleting ? ownerOf(deleting.id) : false"
      @close="deleting = null"
      @deleted="deleted"
    />
  </div>
</template>
