<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { PersonaInfo } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'

// 新建与修改人格共用一个表单；editing 为 null 时是新建。人格的记忆在目录里人格的根下面
const props = defineProps<{
  spaceId: string
  personas: readonly PersonaInfo[]
  editing: PersonaInfo | null
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [persona: PersonaInfo, created: boolean] }>()
const toast = useToast()
const queryClient = useQueryClient()

const form = reactive({ slug: '', name: '', extendsId: null as string | null, description: '' })
watch(open, (value) => {
  if (!value) return
  const p = props.editing
  Object.assign(form, {
    slug: p?.slug ?? '',
    name: p?.name ?? '',
    extendsId: p?.extendsId ?? null,
    description: p?.description ?? '',
  })
})

// 继承的候选：不能选自己和自己的后代（会成环，服务端也会拒绝）
const descendants = (id: string): Set<string> => {
  const found = new Set<string>([id])
  for (let grew = true; grew;) {
    grew = false
    for (const p of props.personas) {
      if (p.extendsId && found.has(p.extendsId) && !found.has(p.id)) {
        found.add(p.id)
        grew = true
      }
    }
  }
  return found
}
const parentItems = computed(() => {
  const excluded = props.editing ? descendants(props.editing.id) : new Set<string>()
  return [
    { label: '不继承', value: null },
    ...props.personas
      .filter((p) => !excluded.has(p.id))
      .map((p) => ({ label: `${p.name}（${p.slug}）`, value: p.id })),
  ]
})

// 保存中不接受第二次提交：连点两次新建会先成功、再报标识已被占用
const saving = ref(false)
async function save() {
  if (saving.value) return
  saving.value = true
  // 请求期间关掉再打开了别的表单，结果不能落到换上来的那个
  const sid = props.spaceId
  const target = props.editing
  try {
    const description = form.description.trim() || null
    const saved = target
      ? // 继承没变时不带上：改继承要锁住空间里的继承关系，只改名称与说明用不着
        await api.updatePersona(sid, target.id, {
          name: form.name,
          description,
          ...(form.extendsId !== target.extendsId ? { extendsId: form.extendsId } : {}),
        })
      : await api.createPersona(sid, {
          slug: form.slug,
          name: form.name,
          extendsId: form.extendsId,
          description,
        })
    if (props.editing === target) open.value = false
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['personas', sid] }),
      queryClient.invalidateQueries({ queryKey: ['persona', sid] }),
    ])
    toast.add({ title: target ? '已保存' : '已创建人格', color: 'success' })
    emit('saved', saved, !target)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <!-- 保存期间不能关：关掉再打开别的表单，保存结果会落到换上来的那个 -->
  <UModal
    :open="open"
    :title="editing ? '修改人格' : '新建人格'"
    :dismissible="!saving"
    :close="!saving"
    @update:open="(v) => (v ? (open = true) : !saving && (open = false))"
  >
    <template #body>
      <form id="persona-form" class="space-y-4" @submit.prevent="save">
        <UFormField
          label="标识"
          :help="
            editing
              ? '标识是这个人格的记忆的坐标开头，不可修改'
              : '小写字母、数字和连字符；用在坐标的开头，例如 persona://doubao/soul'
          "
        >
          <UInput
            v-model="form.slug"
            class="w-full font-mono"
            :disabled="editing !== null"
            required
          />
        </UFormField>
        <UFormField label="名称">
          <UInput v-model="form.name" class="w-full" required />
        </UFormField>
        <UFormField label="继承" help="例如群聊版继承通用版，仅覆盖需要收敛的部分">
          <USelect v-model="form.extendsId" :items="parentItems" class="w-full" />
        </UFormField>
        <UFormField label="说明">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="saving" @click="open = false"
          >取消</UButton
        >
        <UButton type="submit" form="persona-form" :loading="saving">{{
          editing ? '保存' : '创建'
        }}</UButton>
      </div>
    </template>
  </UModal>
</template>
