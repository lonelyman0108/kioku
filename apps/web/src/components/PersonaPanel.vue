<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { PersonaDetail as PersonaDetailData, PersonaInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError, retryable } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from './ConsequenceModal.vue'
import PersonaDetail from './PersonaDetail.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'

// 词表页选中的独立人格：读它的详情与设定段，处理删除确认
const props = defineProps<{
  circleId: string
  personaId: string
  personas: readonly PersonaInfo[]
  canEdit: boolean
}>()
const emit = defineEmits<{
  edit: [persona: PersonaInfo]
  createChild: [parentId: string]
  removed: []
  open: [personaId: string]
}>()
const toast = useToast()
const queryClient = useQueryClient()

const selected = useQuery({
  queryKey: computed(() => ['persona', props.circleId, props.personaId] as const),
  queryFn: ({ queryKey: [, cid, id] }) => api.persona(cid, id),
})
const detail = computed(() =>
  selected.data.value && selected.data.value.id === props.personaId ? selected.data.value : null,
)

const detailRef = ref<InstanceType<typeof PersonaDetail> | null>(null)
defineExpose({ focusTitle: () => detailRef.value?.focusTitle() })

const removing = ref<PersonaDetailData | null>(null)
const deleting = ref(false)
const removeError = ref<string | null>(null)

const removeConsequences = computed(() => {
  const target = removing.value
  if (!target) return []
  const list = [
    `标识 ${target.slug} 将被释放，可用于后续新建人格。`,
    '当前人格自有的设定段将一并删除；仍有子人格、客户端默认人格或按群规则引用时无法删除。',
  ]
  if (target.overrideKeyCount > 0) {
    list.push(
      `${target.overrideKeyCount} 个单独指定此人格的访问密钥将恢复沿用所属客户端的默认人格或按群规则。`,
    )
  }
  return list
})

async function remove() {
  if (!removing.value || deleting.value) return
  deleting.value = true
  removeError.value = null
  const cid = props.circleId
  const id = removing.value.id
  try {
    await api.deletePersona(cid, id)
    removing.value = null
    emit('removed')
    queryClient.removeQueries({ queryKey: ['persona', cid, id] })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['personas', cid] }),
      queryClient.invalidateQueries({ queryKey: ['overview', cid] }),
      queryClient.invalidateQueries({ queryKey: ['clients', cid] }),
      queryClient.invalidateQueries({ queryKey: ['keys', cid] }),
      queryClient.invalidateQueries({ queryKey: ['key-matrix'] }),
    ])
    toast.add({ title: '已删除人格', color: 'success' })
  } catch (err) {
    removeError.value = err instanceof ApiError ? err.message : '删除失败'
    await queryClient.invalidateQueries({ queryKey: ['personas', cid] })
  } finally {
    deleting.value = false
  }
}
</script>

<template>
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
    :circle-id="circleId"
    :persona="detail"
    :personas="personas"
    :can-edit="canEdit"
    @edit="emit('edit', detail)"
    @create-child="emit('createChild', detail.id)"
    @remove="((removing = detail), (removeError = null))"
    @open="(id) => emit('open', id)"
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

  <ConsequenceModal
    :open="removing !== null"
    :title="`删除人格「${removing?.name ?? ''}」？`"
    :consequences="removeConsequences"
    action="删除人格"
    :busy="deleting"
    :error="removeError"
    @close="removing = null"
    @confirm="remove"
  />
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
