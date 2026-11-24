<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { Slug, type PersonaInfo } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { personaOptionItems } from '../personas'
import NoteLine from './strata/NoteLine.vue'

// 新建与修改独立人格共用一个表单；editing 为 null 时是新建。
const props = defineProps<{
  circleId: string
  personas: readonly PersonaInfo[]
  editing: PersonaInfo | null
  initialParentId?: string | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [persona: PersonaInfo, created: boolean] }>()
const toast = useToast()
const queryClient = useQueryClient()

const form = reactive({ slug: '', name: '', extendsId: null as string | null, description: '' })
const touched = reactive({ slug: false, name: false })
const attempted = ref(false)
const error = ref<string | null>(null)

watch(open, (value) => {
  if (!value) return
  const p = props.editing
  Object.assign(form, {
    slug: p?.slug ?? '',
    name: p?.name ?? '',
    extendsId: p ? p.extendsId : (props.initialParentId ?? null),
    description: p?.description ?? '',
  })
  touched.slug = false
  touched.name = false
  attempted.value = false
  error.value = null
})

const parentItems = computed(() => personaOptionItems(props.personas, props.editing?.id ?? null))

const slugProblem = computed(() => {
  if (props.editing) return null
  const slugCheck = Slug.safeParse(form.slug)
  return slugCheck.success ? null : (slugCheck.error.issues[0]?.message ?? '标识格式有误')
})
const nameProblem = computed(() => (form.name.trim() ? null : '请填写名称'))
const problem = computed(() => slugProblem.value ?? nameProblem.value)

// 保存中不接受第二次提交：连点两次新建会先成功、再报标识已被占用
const saving = ref(false)
async function save() {
  attempted.value = true
  if (saving.value || problem.value) return
  saving.value = true
  error.value = null
  const cid = props.circleId
  const target = props.editing
  try {
    const description = form.description.trim() || null
    const saved = target
      ? // 继承没变时不带上：仅改名称与说明时不需要重算继承关系
        await api.updatePersona(cid, target.id, {
          name: form.name.trim(),
          description,
          ...(form.extendsId !== target.extendsId ? { extendsId: form.extendsId } : {}),
        })
      : await api.createPersona(cid, {
          slug: form.slug.trim().toLowerCase(),
          name: form.name.trim(),
          extendsId: form.extendsId,
          description,
        })
    if (props.editing === target) open.value = false
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['personas', cid] }),
      queryClient.invalidateQueries({ queryKey: ['persona', cid] }),
      queryClient.invalidateQueries({ queryKey: ['overview', cid] }),
      queryClient.invalidateQueries({ queryKey: ['clients', cid] }),
      queryClient.invalidateQueries({ queryKey: ['keys', cid] }),
      queryClient.invalidateQueries({ queryKey: ['key-matrix'] }),
    ])
    toast.add({ title: target ? '已保存' : '已创建人格', color: 'success' })
    emit('saved', saved, !target)
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="editing ? '修改人格' : '新建人格'"
    :dismissible="!saving"
    :close="!saving"
    @update:open="(v) => (v ? (open = true) : !saving && (open = false))"
  >
    <template #body>
      <!-- 不用 form：下拉选单选择与输入回车显式点击提交按钮 -->
      <div class="space-y-4">
        <p class="text-sm text-muted">
          人格是独立的设定实体，供客户端、群聊规则与访问密钥绑定，并支持沿父人格继承设定段。
        </p>
        <UFormField
          label="标识"
          :error="!editing && (touched.slug || attempted) ? (slugProblem ?? undefined) : undefined"
          :help="
            editing
              ? '标识用于命令与接口引用，创建后不可修改'
              : '小写字母、数字和连字符，例如 assistant、doubao'
          "
        >
          <UInput
            v-model="form.slug"
            class="w-full font-mono"
            :disabled="editing !== null"
            @blur="touched.slug = true"
          />
        </UFormField>
        <UFormField
          label="名称"
          :error="touched.name || attempted ? (nameProblem ?? undefined) : undefined"
        >
          <UInput v-model="form.name" class="w-full" @blur="touched.name = true" />
        </UFormField>
        <UFormField label="继承" help="例如群聊版继承通用版，仅覆盖需要收敛的设定段">
          <USelect v-model="form.extendsId" :items="parentItems" value-key="value" class="w-full" />
        </UFormField>
        <UFormField label="说明">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>
        <NoteLine v-if="error" tone="error" flush>{{ error }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false"
          >取消</UButton
        >
        <UButton :disabled="Boolean(problem)" :loading="saving" @click="save">{{
          editing ? '保存' : '创建'
        }}</UButton>
      </div>
    </template>
  </UModal>
</template>
