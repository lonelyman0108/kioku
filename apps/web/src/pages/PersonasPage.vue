<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { PersonaInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import PersonaDetail from '../components/PersonaDetail.vue'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'

const route = useRoute()
const router = useRouter()
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

// 打开的是哪个人格记在地址里，从应用详情点过来时直接打开它
function selectPersona(id: string | null) {
  const query = { ...route.query }
  if (id) query.id = id
  else delete query.id
  return router.replace({ query })
}
const closeDetail = () => selectPersona(null)
const selectedId = computed<string | null>({
  get: () => (typeof route.query.id === 'string' ? route.query.id : null),
  set: (id) => void selectPersona(id),
})
const selected = useQuery({
  queryKey: computed(() => ['persona', spaceId.value, selectedId.value] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.persona(sid, id!),
  enabled: computed(() => selectedId.value !== null),
})
const detail = computed(() =>
  selected.data.value && selected.data.value.id === selectedId.value ? selected.data.value : null,
)

// 新建与修改共用一个表单；editing 为 null 时是新建
const open = ref(false)
const editing = ref<PersonaInfo | null>(null)
const form = reactive({ slug: '', name: '', extendsId: null as string | null, description: '' })
// 切换空间时关掉窗口：里面的内容属于上一个空间
watch(spaceId, () => {
  open.value = false
  removing.value = null
})

// 继承的候选：不能选自己和自己的后代（会成环，服务端也会拒绝）
const descendants = (id: string): Set<string> => {
  const all = personas.data.value ?? []
  const found = new Set<string>([id])
  for (let grew = true; grew;) {
    grew = false
    for (const p of all) {
      if (p.extendsId && found.has(p.extendsId) && !found.has(p.id)) {
        found.add(p.id)
        grew = true
      }
    }
  }
  return found
}
const parentItems = computed(() => {
  const excluded = editing.value ? descendants(editing.value.id) : new Set<string>()
  return [
    { label: '不继承', value: null },
    ...(personas.data.value ?? [])
      .filter((p) => !excluded.has(p.id))
      .map((p) => ({ label: `${p.name}（${p.slug}）`, value: p.id })),
  ]
})

function openCreate() {
  editing.value = null
  Object.assign(form, { slug: '', name: '', extendsId: null, description: '' })
  open.value = true
}
function openEdit(persona: PersonaInfo) {
  editing.value = persona
  Object.assign(form, {
    slug: persona.slug,
    name: persona.name,
    extendsId: persona.extendsId,
    description: persona.description ?? '',
  })
  open.value = true
}

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['personas', spaceId.value] }),
    queryClient.invalidateQueries({ queryKey: ['persona', spaceId.value] }),
  ])

// 保存中不接受第二次提交：连点两次新建会先成功、再报标识已被占用
const saving = ref(false)
async function save() {
  if (saving.value) return
  saving.value = true
  // 请求期间切换了空间，结果不能写进新空间的界面；保存的是哪个表单也先记下
  const sid = spaceId.value
  const target = editing.value
  try {
    const description = form.description.trim() || null
    if (target) {
      // 继承没变时不带上：改继承要锁住空间里的继承关系，只改名称与说明用不着
      await api.updatePersona(sid, target.id, {
        name: form.name,
        description,
        ...(form.extendsId !== target.extendsId ? { extendsId: form.extendsId } : {}),
      })
    } else {
      await api.createPersona(sid, {
        slug: form.slug,
        name: form.name,
        extendsId: form.extendsId,
        description,
      })
    }
    if (sid !== spaceId.value) return
    if (editing.value === target) open.value = false
    await refresh()
    toast.add({ title: target ? '已保存' : '已创建人格', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const removing = ref<PersonaInfo | null>(null)
const deleting = ref(false)
async function remove() {
  if (!removing.value || deleting.value) return
  deleting.value = true
  const sid = spaceId.value
  const id = removing.value.id
  try {
    await api.deletePersona(sid, id)
    if (sid !== spaceId.value) return
    removing.value = null
    // 先关掉详情、去掉它的缓存再刷新，免得已删人格的详情再请求一次、闪一下「不存在」
    if (selectedId.value === id) await closeDetail()
    queryClient.removeQueries({ queryKey: ['persona', sid, id] })
    await refresh()
    toast.add({ title: '已删除人格', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '删除失败', color: 'error' })
    await refresh()
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDashboardPanel id="personas">
    <template #header>
      <UDashboardNavbar title="人格">
        <template #right>
          <UButton v-if="canEdit" :icon="icons.add" size="sm" @click="openCreate">新建人格</UButton>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p class="mb-4 text-sm text-muted">
        人格设定写在
        <code>persona://&lt;标识&gt;/</code>
        下的记忆中。
        <Hint>
          子人格可读取所继承人格的记忆，相同相对路径取继承链上最近的一条。应用的默认人格在「应用」页中选择。
        </Hint>
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
        empty="暂无人格"
      >
        <template #name-cell="{ row }">
          <UButton variant="link" class="px-0" @click="selectedId = row.original.id">{{
            row.original.name
          }}</UButton>
        </template>
      </UTable>
    </template>
  </UDashboardPanel>

  <USlideover
    :open="selectedId !== null"
    :title="detail?.name ?? '人格'"
    :ui="{ content: 'max-w-xl' }"
    @update:open="(v) => !v && (selectedId = null)"
  >
    <template #body>
      <UAlert
        v-if="selected.isError.value"
        color="error"
        variant="subtle"
        :title="
          selected.error.value instanceof ApiError ? selected.error.value.message : '读取失败'
        "
      />
      <PersonaDetail
        v-else-if="detail"
        :space-id="spaceId"
        :persona="detail"
        :can-edit="canEdit"
        @edit="openEdit(detail)"
        @remove="removing = detail"
        @open="(id) => (selectedId = id)"
      />
      <USkeleton v-else class="h-40 w-full" />
    </template>
  </USlideover>

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
              ? '标识是人格层记忆 URI 的一部分，不可修改'
              : '小写字母、数字和连字符；用于记忆 URI，例如 persona://doubao/soul'
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
