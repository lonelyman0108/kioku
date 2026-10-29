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

// 绑定记录与确认、拒绝：概览里列出等你确认的，对象页里列出这个对象的。
// subjectId 是所在的对象页；不在对象页（概览）时每条都链到绑到的那个对象
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
      toast.add({ title: `已并进「${kept.displayName}」`, color: 'success' })
      // 在收码那个对象的页面上确认的：它已经并进别的对象、不在了，换到保留的那个对象
      if (props.subjectId && props.subjectId !== kept.id && props.spaceId === spaceId) {
        await router.replace({ name: 'subject', params: { spaceId, subjectId: kept.id } })
      }
    } else {
      await api.rejectBinding(spaceId, binding.id)
      toast.add({ title: '已拒绝，没有合并', color: 'success' })
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

const incomingText = (binding: SubjectBinding) =>
  (binding.incoming?.identities ?? [binding.redeemedBy]).map(accountText).join('、')
</script>

<template>
  <div>
    <ul class="divide-y divide-default">
      <li v-for="binding in items" :key="binding.id" class="space-y-1 py-2 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :color="bindingStatusColors[binding.status]" variant="subtle" size="sm">
            {{ bindingStatusLabels[binding.status] }}
          </UBadge>
          <span class="font-medium">{{ accountText(binding.redeemedBy) }}</span>
          <template v-if="binding.subject.id !== subjectId">
            <span class="text-muted">绑到</span>
            <RouterLink
              :to="{ name: 'subject', params: { spaceId, subjectId: binding.subject.id } }"
              class="hover:underline"
              >{{ binding.subject.displayName }}</RouterLink
            >
          </template>
          <time
            class="ml-auto text-xs text-muted"
            :datetime="binding.createdAt"
            :title="formatTime(binding.createdAt)"
            >{{ formatRelative(binding.createdAt) }}</time
          >
        </div>
        <p v-if="binding.incoming" class="text-xs">
          确认之后并进「{{ binding.subject.displayName }}」的平台账号：{{ incomingText(binding) }}
        </p>
        <p class="text-xs text-muted">{{ bindingSource(binding) }}</p>
        <p class="text-xs text-muted">{{ bindingOutcome(binding) }}</p>
        <div v-if="binding.canConfirm || binding.canReject" class="flex gap-2 pt-1">
          <UButton
            v-if="binding.canConfirm"
            size="xs"
            :disabled="busy !== null"
            @click="confirming = binding"
            >确认</UButton
          >
          <UButton
            v-if="binding.canReject"
            size="xs"
            color="neutral"
            variant="subtle"
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
            把 {{ incomingText(confirming) }} 并进「{{
              confirming.subject.displayName
            }}」：它们记下的事实、私聊里的内容都归过去，之后这些账号的私聊也算你的主人私聊。不能撤销。
          </p>
          <p class="text-muted">不认识这些账号，或者绑定码不是你自己申请的，请拒绝。</p>
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
