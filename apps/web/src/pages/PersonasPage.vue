<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()
const { space } = useSession()
const spaceId = computed(() => String(route.params.spaceId))
const canEdit = computed(() => space.value?.role === 'owner' || space.value?.role === 'editor')

const personas = useQuery({
  queryKey: computed(() => ['personas', spaceId.value]),
  queryFn: () => api.personas(spaceId.value),
})
const nameOf = (id: string | null) => personas.data.value?.find((p) => p.id === id)?.name ?? '—'

const open = ref(false)
// 切换空间时关掉新建窗口：里面的内容属于上一个空间
watch(spaceId, () => (open.value = false))
const form = reactive({ slug: '', name: '', extendsId: null as string | null, description: '' })
const parentItems = computed(() => [
  { label: '不继承', value: null },
  ...(personas.data.value ?? []).map((p) => ({ label: `${p.name}（${p.slug}）`, value: p.id })),
])

async function create() {
  try {
    await api.createPersona(spaceId.value, {
      slug: form.slug,
      name: form.name,
      extendsId: form.extendsId,
      description: form.description.trim() || null,
    })
    open.value = false
    Object.assign(form, { slug: '', name: '', extendsId: null, description: '' })
    await queryClient.invalidateQueries({ queryKey: ['personas', spaceId.value] })
    toast.add({ title: '已创建人格', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '创建失败', color: 'error' })
  }
}
</script>

<template>
  <UDashboardPanel id="personas">
    <template #header>
      <UDashboardNavbar title="人格">
        <template #right>
          <UButton v-if="canEdit" :icon="icons.add" size="sm" @click="open = true"
            >新建人格</UButton
          >
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        人格的设定写在
        <code>persona://&lt;标识&gt;/</code>
        下的记忆里；子人格能读到它继承的人格的记忆。应用在「应用与 Key」里选择默认人格。
      </p>
      <UTable
        :data="personas.data.value ?? []"
        :loading="personas.isPending.value"
        :columns="[
          { accessorKey: 'name', header: '名称' },
          { accessorKey: 'slug', header: '标识' },
          { id: 'extends', header: '继承', cell: ({ row }) => nameOf(row.original.extendsId) },
          { accessorKey: 'description', header: '说明' },
        ]"
      />
    </template>
  </UDashboardPanel>

  <UModal v-model:open="open" title="新建人格">
    <template #body>
      <form id="create-persona" class="space-y-4" @submit.prevent="create">
        <UFormField
          label="标识"
          help="小写字母、数字和连字符；记忆 URI 里用它，例如 persona://doubao/soul"
        >
          <UInput v-model="form.slug" class="w-full font-mono" required />
        </UFormField>
        <UFormField label="名称">
          <UInput v-model="form.name" class="w-full" required />
        </UFormField>
        <UFormField label="继承" help="例如群聊版继承主人格，只覆盖需要收敛的部分">
          <USelect v-model="form.extendsId" :items="parentItems" class="w-full" />
        </UFormField>
        <UFormField label="说明">
          <UInput v-model="form.description" class="w-full" />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">取消</UButton>
        <UButton type="submit" form="create-persona">创建</UButton>
      </div>
    </template>
  </UModal>
</template>
