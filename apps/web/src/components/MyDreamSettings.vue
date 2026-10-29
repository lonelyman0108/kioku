<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'

// 自己在这个空间里的 Dream 设置：每个成员都能改自己的，别人看不到也改不了
const props = defineProps<{ spaceId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const settings = useQuery({
  queryKey: computed(() => ['dream-settings', props.spaceId] as const),
  // 参数从键里取：换了空间之后，旧键还在重新拉取时不会去请求新的空间
  queryFn: ({ queryKey: [, spaceId] }) => api.dreamSettings(spaceId),
})

// 拨一下就保存，开关跟着服务端返回的值走，保存失败时停在原来的位置。
// 记下正在保存的是哪个空间：保存期间换了空间，那边的开关不跟着转圈
const savingFor = ref<string | null>(null)
const saving = computed(() => savingFor.value === props.spaceId)
async function save(includePrivate: boolean) {
  if (saving.value) return
  const spaceId = props.spaceId
  savingFor.value = spaceId
  try {
    const saved = await api.saveDreamSettings(spaceId, { includePrivate })
    queryClient.setQueryData(['dream-settings', spaceId], saved)
    toast.add({
      title: saved.includePrivate
        ? '已打开：Dream 会整理你的画像层与私人层'
        : '已关掉：Dream 只整理共享的内容',
      color: 'success',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    if (savingFor.value === spaceId) savingFor.value = null
  }
}
</script>

<template>
  <UCard class="max-w-2xl shrink-0">
    <template #header>
      <h2 class="font-medium">Dream 与我的私人内容</h2>
      <p class="mt-1 text-sm text-muted">
        Dream 每天整理一次记忆，只提建议，你执行之后才会改。开着时，你的画像层与私人层（secret
        除外）会发给实例配置的抽取模型做整理，关于它们的建议只有你看得到。关掉之后只整理共享的内容：已经生成的建议留着由你处理，再打开时接着整理关掉期间新增与改动的。这个设置只管你自己，每个空间分开设。
      </p>
    </template>
    <UAlert
      v-if="settings.isError.value && !settings.data.value"
      color="error"
      variant="subtle"
      :title="settings.error.value instanceof ApiError ? settings.error.value.message : '读取失败'"
    />
    <USkeleton v-else-if="!settings.data.value" class="h-6 w-72" />
    <USwitch
      v-else
      :model-value="settings.data.value.includePrivate"
      :loading="saving"
      :disabled="saving"
      label="让 Dream 整理我的画像层与私人层"
      @update:model-value="save"
    />
  </UCard>
</template>
