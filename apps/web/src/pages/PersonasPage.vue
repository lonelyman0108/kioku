<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { PersonaInfo } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import Hint from '../components/Hint.vue'
import PersonaDetail from '../components/PersonaDetail.vue'
import { focusAfterSelect, guideLines } from '../components/memoryTree'
import NoteLine from '../components/strata/NoteLine.vue'
import { useSession } from '../composables/useSession'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'
import { personaRows } from '../personas'

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
// 按继承关系排成树
const rows = computed(() => personaRows(personas.data.value ?? []))

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

// 窄屏上列表和详情只显示一个，切换之后原来有焦点的那一行藏起来了：打开时放到详情这一栏，
// 返回时放回原来那一行，那一行没了（刚删掉）就放到列表这一栏
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)
const listColumn = ref<HTMLElement | null>(null)
const detailColumn = ref<HTMLElement | null>(null)
const rowOf = (id: string) =>
  listColumn.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
watch(selectedId, async (id, previous) => {
  const target = focusAfterSelect(narrow.value, id, previous)
  if (!target) return
  await nextTick()
  if (target.to === 'title') return detailColumn.value?.focus()
  ;(rowOf(target.uri) ?? listColumn.value)?.focus()
})
// 从应用详情点过来、或在详情里点了别的人格：列表滚到那一行。只看列表有没有读出来，刷新时不跟着跳
watch(
  [selectedId, () => rows.value.length > 0, listColumn],
  ([id]) => {
    if (id) rowOf(id)?.scrollIntoView({ block: 'nearest' })
  },
  { flush: 'post' },
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
  <!-- 窄屏放不下两栏：选中人格时只显示详情，返回后再显示列表 -->
  <div class="personas" :class="{ 'has-selection': selectedId !== null }">
    <section ref="listColumn" class="list-column" aria-label="人格列表" tabindex="-1">
      <div class="list-head">
        <h2>人格</h2>
        <b v-if="personas.data.value">{{ personas.data.value.length }}</b>
        <UButton
          v-if="canEdit"
          class="ml-auto"
          size="sm"
          color="primary"
          variant="outline"
          @click="openCreate"
        >
          新建
        </UButton>
      </div>
      <p class="list-note">
        人格设定写在 <code>persona://&lt;标识&gt;/</code> 下的记忆中。<Hint>
          子人格可读取所继承人格的记忆，相同相对路径取继承链上最近的一条。应用的默认人格在「应用」页中选择。
        </Hint>
      </p>
      <div class="list-scroll">
        <!-- 后台刷新失败时读到过的列表留着，错误放在上面 -->
        <div v-if="personas.isError.value" class="list-failed">
          <NoteLine tone="error">{{ readFailure(personas.error.value) }}</NoteLine>
        </div>
        <div v-if="personas.isPending.value" class="space-y-2 p-3.5">
          <USkeleton v-for="n in 4" :key="n" class="h-11 w-full" />
        </div>
        <ul v-else-if="rows.length">
          <li v-for="row in rows" :key="row.persona.id">
            <button
              type="button"
              class="persona-row"
              :class="{ selected: row.persona.id === selectedId }"
              :style="{ paddingLeft: `${14 + row.depth * 16}px` }"
              :aria-current="row.persona.id === selectedId ? 'true' : undefined"
              :data-id="row.persona.id"
              @click="selectedId = row.persona.id"
            >
              <template v-for="line in guideLines(row)" :key="line.left">
                <i class="guide" :class="{ end: line.end }" :style="{ left: `${line.left}px` }" />
                <i v-if="line.tick" class="tick" :style="{ left: `${line.left}px` }" />
              </template>
              <span class="persona-name">{{ row.persona.name }}</span>
              <span class="persona-slug">{{ row.persona.slug }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="personas.data.value" class="list-empty">暂无人格</p>
      </div>
    </section>

    <section ref="detailColumn" class="detail-column" aria-label="详情" tabindex="-1">
      <div v-if="selectedId !== null && selected.isError.value" class="detail-note">
        <button type="button" class="back" @click="selectedId = null">
          <UIcon :name="icons.back" class="size-4" />
          返回
        </button>
        <NoteLine tone="error">
          {{ selected.error.value instanceof ApiError ? selected.error.value.message : '读取失败' }}
        </NoteLine>
      </div>
      <PersonaDetail
        v-else-if="detail"
        :key="detail.id"
        :space-id="spaceId"
        :persona="detail"
        :can-edit="canEdit"
        @edit="openEdit(detail)"
        @remove="removing = detail"
        @open="(id) => (selectedId = id)"
      >
        <template #nav>
          <button type="button" class="back" @click="selectedId = null">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
        </template>
      </PersonaDetail>
      <div v-else-if="selectedId !== null" class="detail-note space-y-3">
        <USkeleton class="h-6 w-1/3" />
        <USkeleton class="h-40 w-full" />
      </div>
      <p v-else class="detail-empty">选择一个人格</p>
    </section>
  </div>

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

<style scoped>
.personas {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.list-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--strata-rule);
}
.list-column:focus,
.detail-column:focus {
  outline: 0;
}
.list-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--strata-rule);
}
.list-head h2 {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.list-head b {
  font-family: var(--font-mono);
  font-size: 14px;
  font-weight: 600;
}
.list-note {
  flex: none;
  padding: 7px 14px 8px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.list-note code {
  font-family: var(--font-mono);
  font-size: 13px;
}
.list-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.list-failed {
  padding: 14px 14px 0;
}
.list-empty {
  padding: 18px 14px;
  color: var(--ui-text-muted);
}
.persona-row {
  position: relative;
  display: block;
  width: 100%;
  padding: 7px 14px 6px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.persona-row:hover {
  background: var(--ui-bg-elevated);
}
.persona-row:focus-visible {
  outline-offset: -2px;
}
.persona-row.selected,
.persona-row.selected:hover {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.persona-name {
  display: block;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.persona-slug {
  display: block;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.selected .persona-slug {
  color: var(--strata-on-selected-muted);
}
.guide {
  position: absolute;
  top: 0;
  bottom: -1px;
  width: 1px;
  background: var(--ui-border-accented);
}
.guide.end {
  bottom: 50%;
}
.tick {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 1px;
  background: var(--ui-border-accented);
}
.selected .guide,
.selected .tick {
  background: var(--strata-on-selected-muted);
}
.detail-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.detail-note {
  padding: 24px 32px;
}
.detail-empty {
  padding: 32px;
  color: var(--ui-text-muted);
}
/* 返回只在窄屏有：宽屏上列表一直在旁边 */
.back {
  display: none;
  align-items: center;
  gap: 3px;
  height: 32px;
  margin: -4px 0 4px -3px;
  font-size: 14px;
  color: var(--ui-text-muted);
}

@media (max-width: 1023.98px) {
  .personas {
    grid-template-columns: minmax(0, 1fr);
  }
  .list-column {
    border-right: 0;
  }
  .has-selection .list-column,
  .personas:not(.has-selection) .detail-column {
    display: none;
  }
  .list-head {
    padding: 0 16px;
  }
  .list-note,
  .list-empty {
    padding-left: 16px;
    padding-right: 16px;
  }
  .persona-row {
    padding-right: 16px;
  }
  .back {
    display: inline-flex;
  }
  .detail-note {
    padding: 16px;
  }
  .detail-empty {
    padding: 16px;
  }
}
</style>
