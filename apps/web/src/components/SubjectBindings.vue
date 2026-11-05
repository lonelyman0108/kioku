<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { SubjectBinding } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import {
  accountText,
  bindingOutcome,
  bindingSource,
  bindingStatusColors,
  bindingStatusLabels,
} from '../bindings'
import { refreshSubjectCaches } from '../subjectQueries'
import { formatRelative, formatTime } from '../time'

// 绑定记录与确认、拒绝：待处理页列出等当前账号确认的，联系人页列出这个联系人的。
// subjectId 是所在的联系人页；不在联系人页（待处理）时每条都链到绑到的那个联系人
const props = defineProps<{ spaceId: string; items: SubjectBinding[]; subjectId?: string }>()
const toast = useToast()
const queryClient = useQueryClient()
const router = useRouter()

// 要确认的那一条：确认框打开时记下，框里列出确认之后会并进来的全部平台账号
const confirming = ref<SubjectBinding | null>(null)
const busy = ref<string | null>(null)

async function decide(binding: SubjectBinding, action: 'confirm' | 'reject') {
  if (busy.value) return
  const spaceId = props.spaceId
  busy.value = binding.id
  try {
    if (action === 'confirm') {
      const kept = await api.confirmBinding(spaceId, binding.id)
      toast.add({ title: `已合并到「${kept.displayName}」`, color: 'success' })
      // 在收码那个对象的页面上确认的：它已经并进别的对象、不在了，换到保留的那个对象
      if (props.subjectId && props.subjectId !== kept.id && props.spaceId === spaceId) {
        await router.replace({ name: 'subject', params: { spaceId, subjectId: kept.id } })
      }
    } else {
      await api.rejectBinding(spaceId, binding.id)
      toast.add({ title: '已拒绝，未合并', color: 'success' })
    }
  } catch (err) {
    // 期间被别人合并、取消了标记、过了期限：服务端说明原因，刷新之后这一条显示作废或过期
    toast.add({ title: err instanceof ApiError ? err.message : '操作失败', color: 'error' })
  } finally {
    busy.value = null
    confirming.value = null
    void refreshSubjectCaches(queryClient, spaceId)
  }
}

// 状态只用文字的颜色，不做成彩色徽章
const statusText = { warning: 'text-warning', success: 'text-success', neutral: 'text-muted' }

const incomingText = (binding: SubjectBinding) =>
  (binding.incoming?.identities ?? [binding.redeemedBy]).map(accountText).join('、')
</script>

<template>
  <div>
    <ul>
      <li v-for="binding in items" :key="binding.id" class="binding">
        <div class="binding-main">
          <p class="binding-head">
            <span class="binding-status" :class="statusText[bindingStatusColors[binding.status]]">
              {{ bindingStatusLabels[binding.status] }}
            </span>
            <span class="binding-account">{{ accountText(binding.redeemedBy) }}</span>
            <template v-if="binding.subject.id !== subjectId">
              <span class="text-muted">绑定到</span>
              <RouterLink
                :to="{ name: 'subject', params: { spaceId, subjectId: binding.subject.id } }"
                class="text-primary"
                >{{ binding.subject.displayName }}</RouterLink
              >
            </template>
            <time :datetime="binding.createdAt" :title="formatTime(binding.createdAt)">
              {{ formatRelative(binding.createdAt) }}
            </time>
          </p>
          <p v-if="binding.incoming">
            确认后合并到「{{ binding.subject.displayName }}」的平台账号：{{ incomingText(binding) }}
          </p>
          <p class="text-muted">{{ bindingSource(binding) }}</p>
          <p class="text-muted">{{ bindingOutcome(binding) }}</p>
        </div>
        <div v-if="binding.canConfirm || binding.canReject" class="binding-actions">
          <UButton v-if="binding.canConfirm" :disabled="busy !== null" @click="confirming = binding"
            >确认</UButton
          >
          <UButton
            v-if="binding.canReject"
            color="primary"
            variant="outline"
            :loading="busy === binding.id && confirming === null"
            :disabled="busy !== null"
            @click="decide(binding, 'reject')"
            >拒绝</UButton
          >
        </div>
      </li>
    </ul>
    <UModal
      :open="confirming !== null"
      title="确认这次绑定？"
      @update:open="(open) => !open && busy === null && (confirming = null)"
    >
      <template #body>
        <div v-if="confirming" class="space-y-2 text-sm">
          <p>
            将 {{ incomingText(confirming) }} 合并到「{{
              confirming.subject.displayName
            }}」：这些账号的事实与私聊内容转到「{{
              confirming.subject.displayName
            }}」，原联系人随即删除。此后这些账号的私聊视为本人对话，用哪个账号私聊都能读取私聊内容。此操作不可撤销。
          </p>
          <p class="text-muted">
            在群里记下的事实也归到这里，但可见范围不变，仍只在那个群可见。如无法辨认这些账号，或绑定码并非本人申请，请拒绝。
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="busy !== null"
            @click="confirming = null"
            >取消</UButton
          >
          <UButton :loading="busy !== null" @click="confirming && decide(confirming, 'confirm')"
            >确认合并</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.binding {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.6;
}
.binding-main {
  min-width: 0;
  overflow-wrap: anywhere;
}
.binding-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
}
.binding-status {
  font-size: 13px;
}
.binding-account {
  font-family: var(--font-mono);
  font-size: 15px;
}
.binding-head time {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.binding-actions {
  flex: none;
  display: flex;
  gap: 6px;
}
@media (max-width: 1023.98px) {
  .binding {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
  }
  .binding-actions > * {
    flex: 1;
    justify-content: center;
  }
}
</style>
