<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { dreamSettingsKey } from '../dream'
import Hint from './Hint.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 自己在这个记忆圈里的整理设置：每个成员都能改自己的，别人看不到也改不了
const props = defineProps<{ circleId: string }>()
const toast = useToast()
const queryClient = useQueryClient()

const settings = useQuery({
  queryKey: computed(() => dreamSettingsKey(props.circleId)),
  // 参数从键里取：换了记忆圈之后，旧键还在重新拉取时不会去请求新的记忆圈
  queryFn: ({ queryKey: [, cid] }) => api.dreamSettings(cid),
})

// 拨一下就保存，开关跟着服务端返回的值走，保存失败时停在原来的位置。
// 记下正在保存的是哪个记忆圈：保存期间换了记忆圈，那边的开关不跟着转圈
const savingFor = ref<string | null>(null)
const saving = computed(() => savingFor.value === props.circleId)
async function save(includePrivate: boolean) {
  if (saving.value) return
  const circleId = props.circleId
  savingFor.value = circleId
  try {
    const saved = await api.saveDreamSettings(circleId, { includePrivate })
    queryClient.setQueryData(dreamSettingsKey(circleId), saved)
    toast.add({
      title: saved.includePrivate ? '已开启：将整理当前账号的个人内容' : '已关闭：仅整理共享内容',
      color: 'success',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    if (savingFor.value === circleId) savingFor.value = null
  }
}
</script>

<template>
  <SettingsBlock title="整理" badge="当前账号 · 即时生效" tone="instant">
    <template #note>
      开启后，当前账号的个人内容（机密除外）将发送给抽取模型整理，已发送的内容无法撤回。
      <Hint>
        <p>每天自动整理一次记忆，只提建议，执行后才会修改。相关建议仅当前账号可见。</p>
        <p class="mt-1">
          关闭后仅整理共享内容：已生成的建议保留待处理；再次开启时，继续整理关闭期间新增与修改的内容。正在整理时关闭，结果不保存。
        </p>
        <p class="mt-1">此设置仅对当前账号生效，每个记忆圈单独设置。</p>
      </Hint>
    </template>
    <!-- 后台刷新失败时开关留着，错误放在上面 -->
    <ReadFailureNote v-if="settings.isError.value" :query="settings" />
    <USkeleton v-if="settings.isPending.value" class="h-6 w-72 max-w-full" />
    <USwitch
      v-else-if="settings.data.value"
      :model-value="settings.data.value.includePrivate"
      :loading="saving"
      :disabled="saving"
      label="允许整理本人记忆"
      @update:model-value="save"
    />
  </SettingsBlock>
</template>
