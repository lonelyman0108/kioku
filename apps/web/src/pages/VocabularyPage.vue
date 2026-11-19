<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  CustomFacetDimensionKey,
  FACET_MATCH_MODES,
  FacetAlias,
  FacetTermSlug,
  MAX_FACET_ALIASES,
  normalizeWhen,
  type FacetDimensionView,
  type FacetMatchMode,
  type FacetTermView,
  type FacetVocabularyView,
  type PersonaInfo,
} from '@kioku/contracts'
import type { TabsItem } from '@nuxt/ui'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import FacetWhenPicker from '../components/FacetWhenPicker.vue'
import Hint from '../components/Hint.vue'
import PersonaFormModal from '../components/PersonaFormModal.vue'
import PersonaPanel from '../components/PersonaPanel.vue'
import { guideLines } from '../components/memoryTree'
import EmptyState from '../components/strata/EmptyState.vue'
import NoteLine from '../components/strata/NoteLine.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import SectionHeading from '../components/strata/SectionHeading.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { facetMatchModeLabels } from '../labels'
import { personaRows } from '../personas'

// 词表与人格页：集中管理当前记忆圈的切面维度、词条（含蕴含边与别名）与独立人格树
const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()

const circleId = computed(() => String(route.params.circleId))
const { canEditVocabulary, canEditPersonas } = useMemoryPermissions(circleId)

type Tab = 'facets' | 'personas'
const tab = computed<Tab>(() => (route.query.tab === 'personas' ? 'personas' : 'facets'))
const tabItems: TabsItem[] = [
  { label: '切面词表', value: 'facets' },
  { label: '独立人格', value: 'personas' },
]

function setTab(value: string | number) {
  void router.replace({ query: value === 'personas' ? { tab: 'personas' } : {} })
}

/* ———— 切面词表 ———— */

const facetsQuery = useQuery({
  queryKey: computed(() => ['facets', circleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.facets(cid),
})
const vocab = computed<FacetVocabularyView | null>(() => facetsQuery.data.value ?? null)
const dimensions = computed(() => vocab.value?.dimensions ?? [])
const terms = computed(() => vocab.value?.terms ?? [])

const selectedDimKey = ref<string>('realm')
watch(
  dimensions,
  (list) => {
    if (!list.length) return
    if (!list.some((d) => d.key === selectedDimKey.value)) {
      selectedDimKey.value = list[0]!.key
    }
  },
  { immediate: true },
)

const selectedDim = computed<FacetDimensionView | null>(
  () => dimensions.value.find((d) => d.key === selectedDimKey.value) ?? dimensions.value[0] ?? null,
)
const activeDimTerms = computed<FacetTermView[]>(() =>
  selectedDim.value ? terms.value.filter((t) => t.dimensionKey === selectedDim.value!.key) : [],
)

const termLabelMap = computed(() => {
  const map = new Map<string, string>()
  for (const t of terms.value) map.set(`${t.dimensionKey}:${t.slug}`, t.label)
  return map
})

function impliesTags(term: FacetTermView): string[] {
  const list: string[] = []
  for (const [dim, slugs] of Object.entries(term.implies)) {
    const dimName = dimensions.value.find((d) => d.key === dim)?.name ?? dim
    for (const slug of slugs) {
      const label = termLabelMap.value.get(`${dim}:${slug}`) ?? slug
      list.push(`${dimName}: ${label}`)
    }
  }
  return list
}

const matchModeOptions = FACET_MATCH_MODES.map((value) => ({
  label: facetMatchModeLabels[value],
  value,
}))

async function invalidateFacets(cid: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['facets', cid] }),
    queryClient.invalidateQueries({ queryKey: ['overview', cid] }),
  ])
}

// 维度创建与修改弹窗
const dimModalOpen = ref(false)
const editingDim = ref<FacetDimensionView | null>(null)
const dimForm = reactive({
  key: '',
  name: '',
  matchMode: 'exclusive' as FacetMatchMode,
  description: '',
})
const dimError = ref<string | null>(null)
const savingDim = ref(false)

function openCreateDim() {
  editingDim.value = null
  dimForm.key = ''
  dimForm.name = ''
  dimForm.matchMode = 'exclusive'
  dimForm.description = ''
  dimError.value = null
  dimModalOpen.value = true
}

function openEditDim(dim: FacetDimensionView) {
  editingDim.value = dim
  dimForm.key = dim.key
  dimForm.name = dim.name
  dimForm.matchMode = dim.matchMode
  dimForm.description = dim.description ?? ''
  dimError.value = null
  dimModalOpen.value = true
}

const dimProblem = computed(() => {
  if (!editingDim.value) {
    const res = CustomFacetDimensionKey.safeParse(dimForm.key)
    if (!res.success) return res.error.issues[0]?.message ?? '维度键格式有误'
  }
  if (!dimForm.name.trim()) return '请填写维度名称'
  return null
})

async function saveDimension() {
  if (savingDim.value || dimProblem.value) return
  savingDim.value = true
  dimError.value = null
  const cid = circleId.value
  try {
    const description = dimForm.description.trim() || null
    if (editingDim.value) {
      await api.updateFacetDimension(cid, editingDim.value.key, {
        name: dimForm.name.trim(),
        matchMode: dimForm.matchMode,
        description,
      })
      toast.add({ title: '已保存维度', color: 'success' })
    } else {
      const created = await api.createFacetDimension(cid, {
        key: dimForm.key.trim().toLowerCase(),
        name: dimForm.name.trim(),
        matchMode: dimForm.matchMode,
        description,
      })
      selectedDimKey.value = created.key
      toast.add({ title: '已创建维度', color: 'success' })
    }
    dimModalOpen.value = false
    await invalidateFacets(cid)
  } catch (err) {
    dimError.value = err instanceof ApiError ? err.message : '保存失败'
  } finally {
    savingDim.value = false
  }
}

const deletingDim = ref<FacetDimensionView | null>(null)
const deletingDimBusy = ref(false)
const deleteDimError = ref<string | null>(null)

async function removeDimension() {
  const target = deletingDim.value
  if (!target || deletingDimBusy.value) return
  deletingDimBusy.value = true
  deleteDimError.value = null
  const cid = circleId.value
  try {
    await api.deleteFacetDimension(cid, target.key)
    deletingDim.value = null
    if (selectedDimKey.value === target.key) selectedDimKey.value = 'realm'
    toast.add({ title: '已删除维度', color: 'success' })
    await invalidateFacets(cid)
  } catch (err) {
    deleteDimError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deletingDimBusy.value = false
  }
}

// 词条创建与修改弹窗（含 implies DAG 与别名）
const termModalOpen = ref(false)
const editingTerm = ref<FacetTermView | null>(null)
const termForm = reactive({
  slug: '',
  label: '',
  aliasesText: '',
  implies: {} as Record<string, string[]>,
})
const termError = ref<string | null>(null)
const savingTerm = ref(false)

function openCreateTerm() {
  editingTerm.value = null
  termForm.slug = ''
  termForm.label = ''
  termForm.aliasesText = ''
  termForm.implies = {}
  termError.value = null
  termModalOpen.value = true
}

function openEditTerm(term: FacetTermView) {
  editingTerm.value = term
  termForm.slug = term.slug
  termForm.label = term.label
  termForm.aliasesText = term.aliases.join(', ')
  termForm.implies = normalizeWhen(term.implies)
  termError.value = null
  termModalOpen.value = true
}

const pickerVocab = computed<FacetVocabularyView | null>(() => {
  if (!vocab.value) return null
  if (!editingTerm.value) return vocab.value
  return {
    ...vocab.value,
    terms: vocab.value.terms.filter((t) => t.id !== editingTerm.value!.id),
  }
})

const parsedAliases = computed(() => {
  const raw = termForm.aliasesText
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of raw) {
    const res = FacetAlias.safeParse(item)
    if (!res.success) {
      return { ok: false as const, message: res.error.issues[0]?.message ?? '触发词格式有误' }
    }
    if (!seen.has(res.data)) {
      seen.add(res.data)
      list.push(res.data)
    }
  }
  if (list.length > MAX_FACET_ALIASES) {
    return { ok: false as const, message: `触发词最多 ${MAX_FACET_ALIASES} 个` }
  }
  return { ok: true as const, list }
})

const termProblem = computed(() => {
  if (!editingTerm.value) {
    const slugRes = FacetTermSlug.safeParse(termForm.slug)
    if (!slugRes.success) return slugRes.error.issues[0]?.message ?? '词条标识格式有误'
  }
  if (!termForm.label.trim()) return '请填写显示名称'
  if (!parsedAliases.value.ok) return parsedAliases.value.message
  return null
})

async function saveTerm() {
  const dim = selectedDim.value
  if (!dim || savingTerm.value || termProblem.value) return
  savingTerm.value = true
  termError.value = null
  const cid = circleId.value
  try {
    const aliases = parsedAliases.value.ok ? parsedAliases.value.list : []
    const implies = normalizeWhen(termForm.implies)
    if (editingTerm.value) {
      await api.updateFacetTerm(cid, editingTerm.value.id, {
        label: termForm.label.trim(),
        aliases,
        implies,
      })
      toast.add({ title: '已保存词条', color: 'success' })
    } else {
      await api.createFacetTerm(cid, {
        dimensionKey: dim.key,
        slug: termForm.slug.trim().toLowerCase(),
        label: termForm.label.trim(),
        aliases,
        implies,
      })
      toast.add({ title: '已添加词条', color: 'success' })
    }
    termModalOpen.value = false
    await invalidateFacets(cid)
  } catch (err) {
    // 包括后端检查出的蕴含成环（400/409）或标识冲突，直接在弹窗内留着修改
    termError.value = err instanceof ApiError ? err.message : '保存失败'
  } finally {
    savingTerm.value = false
  }
}

const deletingTerm = ref<FacetTermView | null>(null)
const deletingTermBusy = ref(false)
const deleteTermError = ref<string | null>(null)

async function removeTerm() {
  const target = deletingTerm.value
  if (!target || deletingTermBusy.value) return
  deletingTermBusy.value = true
  deleteTermError.value = null
  const cid = circleId.value
  try {
    await api.deleteFacetTerm(cid, target.id)
    deletingTerm.value = null
    toast.add({ title: '已删除词条', color: 'success' })
    await invalidateFacets(cid)
  } catch (err) {
    deleteTermError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deletingTermBusy.value = false
  }
}

/* ———— 独立人格 ———— */

const personasQuery = useQuery({
  queryKey: computed(() => ['personas', circleId.value] as const),
  queryFn: ({ queryKey: [, cid] }) => api.personas(cid),
  enabled: computed(() => tab.value === 'personas'),
})
const personas = computed(() => personasQuery.data.value ?? [])
const rows = computed(() => personaRows(personas.value))

const selectedPersonaId = computed(() => {
  const fromQuery = typeof route.query.persona === 'string' ? route.query.persona : ''
  if (fromQuery && personas.value.some((p) => p.id === fromQuery)) return fromQuery
  return personas.value[0]?.id ?? ''
})

function selectPersona(id: string) {
  void router.replace({ query: { tab: 'personas', persona: id } })
}

const personaFormOpen = ref(false)
const editingPersona = ref<PersonaInfo | null>(null)

function openCreatePersona() {
  editingPersona.value = null
  personaFormOpen.value = true
}

function openEditPersona(p: PersonaInfo) {
  editingPersona.value = p
  personaFormOpen.value = true
}

function onPersonaSaved(saved: PersonaInfo, created: boolean) {
  if (created || selectedPersonaId.value === saved.id) selectPersona(saved.id)
}

function onPersonaRemoved() {
  const remaining = personas.value.filter((p) => p.id !== selectedPersonaId.value)
  if (remaining.length) selectPersona(remaining[0]!.id)
  else void router.replace({ query: { tab: 'personas' } })
}
</script>

<template>
  <div class="vocab-page">
    <header class="vocab-head">
      <div class="head-top">
        <UTabs
          :model-value="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          size="md"
          :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
          @update:model-value="setTab"
        />
        <div class="head-actions">
          <UButton
            v-if="tab === 'facets' && canEditVocabulary"
            size="sm"
            variant="outline"
            :icon="icons.add"
            @click="openCreateDim"
          >
            新建维度
          </UButton>
          <UButton
            v-else-if="tab === 'personas' && canEditPersonas"
            size="sm"
            :icon="icons.add"
            @click="openCreatePersona"
          >
            新建人格
          </UButton>
        </div>
      </div>
    </header>

    <!-- 切面词表 -->
    <div v-if="tab === 'facets'" class="vocab-body">
      <div v-if="facetsQuery.isError.value" class="p-6">
        <ReadFailureNote :query="facetsQuery" />
      </div>
      <div v-if="facetsQuery.isPending.value" class="p-6 space-y-3">
        <USkeleton class="h-12 w-full" />
        <USkeleton class="h-48 w-full" />
      </div>
      <div v-else-if="facetsQuery.data.value" class="split-layout">
        <aside class="side-list" aria-label="切面维度列表">
          <ul>
            <li v-for="dim in dimensions" :key="dim.key">
              <button
                type="button"
                class="dim-row"
                :class="{ selected: dim.key === selectedDim?.key }"
                @click="selectedDimKey = dim.key"
              >
                <span class="dim-top">
                  <span class="dim-name">{{ dim.name }}</span>
                  <span class="dim-badge">{{ facetMatchModeLabels[dim.matchMode] }}</span>
                </span>
                <span class="dim-sub">
                  <code>{{ dim.key }}</code>
                  <span>{{ terms.filter((t) => t.dimensionKey === dim.key).length }} 词条</span>
                </span>
              </button>
            </li>
          </ul>
        </aside>

        <section v-if="selectedDim" class="detail-pane">
          <div class="pane-head">
            <div>
              <div class="pane-title-row">
                <h2>{{ selectedDim.name }}</h2>
                <code class="pane-key">{{ selectedDim.key }}</code>
                <span class="pane-pill">{{ facetMatchModeLabels[selectedDim.matchMode] }}</span>
                <span v-if="selectedDim.builtin" class="pane-pill">内置</span>
                <span v-if="selectedDim.autoRegister" class="pane-pill">支持自动登记</span>
              </div>
              <p v-if="selectedDim.description" class="pane-desc">{{ selectedDim.description }}</p>
              <p v-if="selectedDim.builtin" class="pane-note">
                内置维度由系统提供，可自由增删其下的词条。
              </p>
            </div>
            <div v-if="canEditVocabulary" class="pane-actions">
              <UButton size="sm" :icon="icons.add" @click="openCreateTerm">新增词条</UButton>
              <UButton
                v-if="!selectedDim.builtin"
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.edit"
                @click="openEditDim(selectedDim)"
              >
                编辑维度
              </UButton>
              <UButton
                v-if="!selectedDim.builtin"
                size="sm"
                color="error"
                variant="outline"
                :icon="icons.remove"
                @click="((deletingDim = selectedDim), (deleteDimError = null))"
              >
                删除
              </UButton>
            </div>
          </div>

          <SectionHeading :title="`词条（${activeDimTerms.length}）`" class="mt-5">
            <template #hint>
              <Hint>
                词条可通过「蕴含」展开关联切面（例如特定工作项目蕴含工作场域）；配置「触发词」后，在提问包含对应别名时可作为破壁信号增强召回。
              </Hint>
            </template>
          </SectionHeading>

          <EmptyState
            v-if="!activeDimTerms.length"
            title="暂无词条"
            description="在这个维度下添加词条后，可供变体切片与固定切面透镜选用。"
          />
          <ul v-else class="term-list">
            <li v-for="term in activeDimTerms" :key="term.id" class="term-row">
              <div class="term-main">
                <div class="term-head">
                  <span class="term-label">{{ term.label }}</span>
                  <code class="term-slug">{{ term.slug }}</code>
                  <span v-if="term.autoRegistered" class="term-tag">自动登记</span>
                </div>
                <p v-if="term.aliases.length" class="term-meta">
                  <span class="meta-k">触发词：</span>
                  <span v-for="a in term.aliases" :key="a" class="alias-tag">{{ a }}</span>
                </p>
                <p v-if="impliesTags(term).length" class="term-meta">
                  <span class="meta-k">蕴含：</span>
                  <span v-for="imp in impliesTags(term)" :key="imp" class="implies-tag">{{
                    imp
                  }}</span>
                </p>
              </div>
              <div v-if="canEditVocabulary" class="term-actions">
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.edit"
                  :aria-label="`编辑词条 ${term.label}`"
                  @click="openEditTerm(term)"
                />
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="text-muted hover:text-error"
                  :icon="icons.remove"
                  :aria-label="`删除词条 ${term.label}`"
                  @click="((deletingTerm = term), (deleteTermError = null))"
                />
              </div>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <!-- 独立人格 -->
    <div v-else class="vocab-body">
      <div v-if="personasQuery.isError.value" class="p-6">
        <ReadFailureNote :query="personasQuery" />
      </div>
      <div v-if="personasQuery.isPending.value" class="p-6 space-y-3">
        <USkeleton class="h-12 w-full" />
        <USkeleton class="h-48 w-full" />
      </div>
      <EmptyState
        v-else-if="personasQuery.data.value && !personas.length"
        title="暂无独立人格"
        description="新建人格后，可为其配置可继承的设定段并绑定到接入实例或访问密钥。"
      >
        <template v-if="canEditPersonas" #actions>
          <UButton @click="openCreatePersona">新建人格</UButton>
        </template>
      </EmptyState>
      <div v-else-if="personasQuery.data.value" class="split-layout">
        <aside class="side-list" aria-label="人格继承树">
          <ul>
            <li v-for="row in rows" :key="row.persona.id">
              <button
                type="button"
                class="persona-row"
                :class="{ selected: row.persona.id === selectedPersonaId }"
                :style="{ paddingLeft: `${14 + row.depth * 16}px` }"
                @click="selectPersona(row.persona.id)"
              >
                <span
                  v-for="(line, i) in guideLines(row)"
                  :key="i"
                  class="guide"
                  :class="{ end: line.end, tick: line.tick }"
                  :style="{ left: `${line.left}px` }"
                  aria-hidden="true"
                />
                <StrataSwatch band="persona" plain decorative />
                <span class="persona-name">{{ row.persona.name }}</span>
                <code class="persona-slug">{{ row.persona.slug }}</code>
              </button>
            </li>
          </ul>
        </aside>

        <div class="persona-pane">
          <PersonaPanel
            v-if="selectedPersonaId"
            :circle-id="circleId"
            :persona-id="selectedPersonaId"
            :personas="personas"
            :can-edit="canEditPersonas"
            @edit="openEditPersona"
            @removed="onPersonaRemoved"
            @open="selectPersona"
          />
        </div>
      </div>
    </div>
  </div>

  <!-- 新建/编辑维度弹窗（不用 form） -->
  <UModal
    :open="dimModalOpen"
    :title="editingDim ? '编辑切面维度' : '新建切面维度'"
    :dismissible="!savingDim"
    :close="!savingDim"
    @update:open="(v) => !v && !savingDim && (dimModalOpen = false)"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField
          label="维度键"
          help="小写字母开头，可包含小写字母、数字和下划线；创建后不可修改"
        >
          <UInput v-model="dimForm.key" class="w-full font-mono" :disabled="editingDim !== null" />
        </UFormField>
        <UFormField label="维度名称">
          <UInput v-model="dimForm.name" placeholder="例如 业务领域" class="w-full" />
        </UFormField>
        <UFormField
          label="匹配模式"
          help="排他维在无交集时会收敛权重或剥离穿透；叠加维仅加分不排斥"
        >
          <USelect
            v-model="dimForm.matchMode"
            :items="matchModeOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <UFormField label="说明">
          <UInput v-model="dimForm.description" class="w-full" />
        </UFormField>
        <NoteLine v-if="dimError" tone="error" flush>{{ dimError }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="savingDim"
          @click="dimModalOpen = false"
        >
          取消
        </UButton>
        <UButton :disabled="Boolean(dimProblem)" :loading="savingDim" @click="saveDimension">
          保存
        </UButton>
      </div>
    </template>
  </UModal>

  <ConsequenceModal
    :open="deletingDim !== null"
    :title="`删除维度「${deletingDim?.name ?? ''}」？`"
    :consequences="[
      `维度 ${deletingDim?.key ?? ''} 及其下的全部词条将一并删除。`,
      '若其他维度的词条仍在蕴含引用此维度的词条，将无法删除。',
    ]"
    action="删除维度"
    :busy="deletingDimBusy"
    :error="deleteDimError"
    @close="deletingDim = null"
    @confirm="removeDimension"
  />

  <!-- 新建/编辑词条弹窗（不用 form） -->
  <UModal
    :open="termModalOpen"
    :title="editingTerm ? '编辑词条' : '新增词条'"
    :dismissible="!savingTerm"
    :close="!savingTerm"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(v) => !v && !savingTerm && (termModalOpen = false)"
  >
    <template #body>
      <div class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="标识" help="小写字母、数字、中文及 ._-；创建后不可修改">
            <UInput
              v-model="termForm.slug"
              class="w-full font-mono"
              :disabled="editingTerm !== null"
            />
          </UFormField>
          <UFormField label="显示名称">
            <UInput v-model="termForm.label" placeholder="例如 公司工作" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="触发词（别名）" help="多个触发词用逗号或换行分隔，每个 2 到 48 字">
          <UTextarea
            v-model="termForm.aliasesText"
            :rows="2"
            placeholder="例如 公司, 办公室, 加班"
            class="w-full"
          />
        </UFormField>

        <UFormField
          label="蕴含切面（有向无环展开）"
          help="命中当前词条时，同时自动展开下列切面词条（如成环将被服务端拒绝）"
        >
          <FacetWhenPicker
            v-model="termForm.implies"
            :circle-id="circleId"
            :vocabulary="pickerVocab"
          />
        </UFormField>

        <NoteLine v-if="termError" tone="error" flush>{{ termError }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="savingTerm"
          @click="termModalOpen = false"
        >
          取消
        </UButton>
        <UButton :disabled="Boolean(termProblem)" :loading="savingTerm" @click="saveTerm">
          保存
        </UButton>
      </div>
    </template>
  </UModal>

  <ConsequenceModal
    :open="deletingTerm !== null"
    :title="`删除词条「${deletingTerm?.label ?? ''}」？`"
    :consequences="[
      `词条 ${deletingTerm?.slug ?? ''} 及其触发词配置将被移除。`,
      '若有变体或蕴含规则引用它，引用保留但不再展开此词条名。',
    ]"
    action="删除词条"
    :busy="deletingTermBusy"
    :error="deleteTermError"
    @close="deletingTerm = null"
    @confirm="removeTerm"
  />

  <PersonaFormModal
    v-model:open="personaFormOpen"
    :circle-id="circleId"
    :personas="personas"
    :editing="editingPersona"
    @saved="onPersonaSaved"
  />
</template>

<style scoped>
.vocab-page {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vocab-head {
  flex: none;
  border-bottom: 1px solid var(--strata-rule);
}
.head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 44px;
  padding: 0 16px 0 8px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vocab-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.split-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
}
.side-list {
  overflow-y: auto;
  border-right: 1px solid var(--strata-rule);
}
.dim-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 10px 14px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.dim-row:hover {
  background: var(--ui-bg-elevated);
}
.dim-row.selected {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.dim-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.dim-name {
  font-size: 14px;
  font-weight: 500;
}
.dim-badge {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.dim-sub {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.dim-row.selected .dim-badge,
.dim-row.selected .dim-sub {
  color: var(--strata-on-selected-muted);
}

.detail-pane {
  overflow-y: auto;
  padding: 20px 32px 48px;
}
.pane-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.pane-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.pane-title-row h2 {
  font-size: 20px;
  font-weight: 500;
}
.pane-key {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.pane-pill {
  padding: 0 6px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 18px;
  color: var(--ui-text-muted);
}
.pane-desc,
.pane-note {
  margin-top: 4px;
  font-size: 13px;
  color: var(--ui-text-muted);
}
.pane-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.term-list {
  margin-top: 8px;
}
.term-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
}
.term-main {
  min-width: 0;
  flex: 1;
}
.term-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.term-label {
  font-size: 14px;
  font-weight: 500;
}
.term-slug {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.term-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.term-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  margin-top: 4px;
  font-size: 12px;
}
.meta-k {
  color: var(--ui-text-muted);
}
.alias-tag,
.implies-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
  color: var(--ui-text-toned);
}
.term-actions {
  display: flex;
  flex: none;
  gap: 2px;
}

.persona-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.persona-row:hover {
  background: var(--ui-bg-elevated);
}
.persona-row.selected {
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.persona-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.persona-slug {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.persona-row.selected .persona-slug {
  color: var(--strata-on-selected-muted);
}
.persona-pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-border);
}
.guide.end {
  bottom: 50%;
}
.guide.tick::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 7px;
  height: 1px;
  background: var(--ui-border);
}

@media (max-width: 1023.98px) {
  .split-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .side-list {
    max-height: 220px;
    border-right: 0;
    border-bottom: 1px solid var(--strata-rule);
  }
  .detail-pane {
    padding: 16px;
  }
}
</style>
