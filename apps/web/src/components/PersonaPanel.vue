<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { PersonaInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError, retryable } from '../api/client'
import { api } from '../api/endpoints'
import PersonaDetail from './PersonaDetail.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'

// 记忆目录里选中的人格：读它的详情，处理删除。修改人格的表单由记忆页统一放
const props = defineProps<{
  spaceId: string
  personaId: string
  canEdit: boolean
  canWrite: boolean
}>()
const emit = defineEmits<{
  edit: [persona: PersonaInfo]
  removed: []
  create: []
  open: [personaId: string]
  openApp: [appId: string]
}>()
const toast = useToast()
const queryClient = useQueryClient()

const selected = useQuery({
  queryKey: computed(() => ['persona', props.spaceId, props.personaId] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.persona(sid, id),
})
const detail = computed(() =>
  selected.data.value && selected.data.value.id === props.personaId ? selected.data.value : null,
)

const detailRef = ref<InstanceType<typeof PersonaDetail> | null>(null)
defineExpose({ focusTitle: () => detailRef.value?.focusTitle() })

const removing = ref<PersonaInfo | null>(null)
const deleting = ref(false)
async function remove() {
  if (!removing.value || deleting.value) return
  deleting.value = true
  const sid = props.spaceId
  const id = removing.value.id
  try {
    await api.deletePersona(sid, id)
    removing.value = null
    // 先关掉详情、去掉它的缓存再刷新，免得已删人格的详情再请求一次、闪一下「不存在」
    emit('removed')
    queryClient.removeQueries({ queryKey: ['persona', sid, id] })
    await queryClient.invalidateQueries({ queryKey: ['personas', sid] })
    toast.add({ title: '已删除人格', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
    await queryClient.invalidateQueries({ queryKey: ['persona', sid] })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <!--
    没读到过，或者是确定的结果（别处删掉之后的 404）：整块报错，旧内容和操作都不留。
    还能再读的刷新失败才照常显示详情，错误放在记忆上面
  -->
  <div
    v-if="selected.isError.value && (!detail || !retryable(selected.error.value))"
    class="detail-note"
  >
    <slot name="nav" />
    <ReadFailureNote :query="selected" />
  </div>
  <PersonaDetail
    v-else-if="detail"
    ref="detailRef"
    :space-id="spaceId"
    :persona="detail"
    :can-edit="canEdit"
    :can-write="canWrite"
    @edit="emit('edit', detail)"
    @remove="removing = detail"
    @create="emit('create')"
    @open="(id) => emit('open', id)"
    @open-app="(id) => emit('openApp', id)"
  >
    <template #nav><slot name="nav" /></template>
    <template v-if="selected.isError.value" #notice>
      <ReadFailureNote :query="selected" />
    </template>
  </PersonaDetail>
  <div v-else class="detail-note space-y-3">
    <slot name="nav" />
    <USkeleton class="h-6 w-1/3" />
    <USkeleton class="h-40 w-full" />
  </div>

  <UModal
    :open="removing !== null"
    title="删除这个人格？"
    :dismissible="!deleting"
    @update:open="(v) => !v && !deleting && (removing = null)"
  >
    <template #body>
      <p class="text-sm">
        删除「{{ removing?.name }}」后，标识 <code>{{ removing?.slug }}</code> 可用于新人格。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="deleting" @click="removing = null"
          >取消</UButton
        >
        <UButton color="error" :loading="deleting" @click="remove">删除</UButton>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.detail-note {
  padding: 24px 32px;
}
@media (max-width: 1023.98px) {
  .detail-note {
    padding: 16px;
  }
}
</style>
