<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { dreamSettingsKey } from '../dream'
import Hint from './Hint.vue'

// 自己在这个空间里的 Dream 设置：每个成员都能改自己的，别人看不到也改不了
const props = defineProps<{ spaceId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const settings = useQuery({
  queryKey: computed(() => dreamSettingsKey(props.spaceId)),
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
    queryClient.setQueryData(dreamSettingsKey(spaceId), saved)
    toast.add({
      title: saved.includePrivate
        ? '已开启：Dream 将整理当前账号的个人画像层与私人层'
        : '已关闭：Dream 仅整理共享内容',
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
      <h2 class="font-medium">Dream 与私人内容</h2>
      <p class="mt-1 text-sm text-muted">
        开启后，当前账号的个人画像层与私人层（机密除外）将发送给抽取模型整理。
        <Hint>
          <p>Dream 每天整理一次记忆，只提建议，执行后才会修改。相关建议仅当前账号可见。</p>
          <p class="mt-1">
            关闭后仅整理共享内容：已生成的建议保留待处理；再次开启时，继续整理关闭期间新增与修改的内容。正在整理时关闭，已发送给模型的内容无法撤回，但结果不保存。
          </p>
          <p class="mt-1">此设置仅对当前账号生效，每个空间单独设置。</p>
        </Hint>
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
      label="允许 Dream 整理个人画像层与私人层"
      @update:model-value="save"
    />
  </UCard>
</template>
