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
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { facetMatchModeLabels } from '../labels'
import ConsequenceModal from './ConsequenceModal.vue'
import FacetWhenPicker from './FacetWhenPicker.vue'
import Hint from './Hint.vue'
import EmptyState from './strata/EmptyState.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import SettingsBlock from './strata/SettingsBlock.vue'

// 记忆圈设置 › 语境词典：管理本记忆圈的适用条件维度、条件项、自动关联与唤醒别名
defineModel<boolean>('dirty', { default: false })

const route = useRoute()
const toast = useToast()
const queryClient = useQueryClient()

const circleId = computed(() => String(route.params.circleId))
const { canEditVocabulary } = useMemoryPermissions(circleId)

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
      return { ok: false as const, message: res.error.issues[0]?.message ?? '唤醒别名格式有误' }
    }
    if (!seen.has(res.data)) {
      seen.add(res.data)
      list.push(res.data)
    }
  }
  if (list.length > MAX_FACET_ALIASES) {
    return { ok: false as const, message: `唤醒别名最多 ${MAX_FACET_ALIASES} 个` }
  }
  return { ok: true as const, list }
})

const termProblem = computed(() => {
  if (!editingTerm.value) {
    const slugRes = FacetTermSlug.safeParse(termForm.slug)
    if (!slugRes.success) return slugRes.error.issues[0]?.message ?? '标识格式有误'
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
      toast.add({ title: '已保存条件项', color: 'success' })
    } else {
      await api.createFacetTerm(cid, {
        dimensionKey: dim.key,
        slug: termForm.slug.trim().toLowerCase(),
        label: termForm.label.trim(),
        aliases,
        implies,
      })
      toast.add({ title: '已添加条件项', color: 'success' })
    }
    termModalOpen.value = false
    await invalidateFacets(cid)
  } catch (err) {
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
    toast.add({ title: '已删除条件项', color: 'success' })
    await invalidateFacets(cid)
  } catch (err) {
    deleteTermError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deletingTermBusy.value = false
  }
}
</script>

<template>
  <div>
    <SettingsBlock
      title="语境词典"
      description="定义记忆变体与客户端默认语境可选的适用条件维度、自动关联与唤醒别名"
    >
      <template v-if="canEditVocabulary" #actions>
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          :icon="icons.add"
          @click="openCreateDim"
        >
          新建维度
        </UButton>
      </template>

      <ReadFailureNote v-if="facetsQuery.isError.value" :query="facetsQuery" />
      <div v-if="facetsQuery.isPending.value" class="space-y-3 py-3">
        <USkeleton class="h-10 w-full" />
        <USkeleton class="h-44 w-full" />
      </div>
      <div v-else-if="facetsQuery.data.value" class="vocab-box">
        <aside class="dim-list" aria-label="适用条件维度列表">
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
                  <span class="tabular-nums"
                    >{{ terms.filter((t) => t.dimensionKey === dim.key).length }} 项</span
                  >
                </span>
              </button>
            </li>
          </ul>
        </aside>

        <section v-if="selectedDim" class="dim-detail">
          <div class="pane-head">
            <div>
              <div class="pane-title-row">
                <h3>{{ selectedDim.name }}</h3>
                <code class="pane-key">{{ selectedDim.key }}</code>
                <span class="pane-pill">{{ facetMatchModeLabels[selectedDim.matchMode] }}</span>
                <span v-if="selectedDim.builtin" class="pane-pill">内置</span>
                <span v-if="selectedDim.autoRegister" class="pane-pill">支持自动登记</span>
              </div>
              <p v-if="selectedDim.description" class="pane-desc">{{ selectedDim.description }}</p>
              <p class="pane-note">
                <template v-if="selectedDim.matchMode === 'exclusive'">
                  单选互斥：启动加载时剔除与当前语境冲突的变体，召回时对冲突条件扣分。
                </template>
                <template v-else> 多选叠加：命中当前语境时加分，不同选项之间互不排斥。 </template>
                <template v-if="selectedDim.autoRegister">
                  客户端上报新的代码仓库时自动登记条件项，可在此补充自动关联与唤醒别名。
                </template>
              </p>
            </div>
            <div v-if="canEditVocabulary" class="pane-actions">
              <UButton size="sm" :icon="icons.add" @click="openCreateTerm">新增条件项</UButton>
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

          <SectionHeading :title="`条件项（${activeDimTerms.length}）`" class="mt-4">
            <template #hint>
              <Hint>
                条件项可通过「自动关联」展开其他维度的条件（例如某台办公电脑自动关联 Windows
                与公司场域，最多展开 4
                级且禁止成环）；配置「唤醒别名」后，提问按词边界命中别名时临时将该条件并入本轮查询焦点。
              </Hint>
            </template>
          </SectionHeading>

          <EmptyState
            v-if="!activeDimTerms.length"
            title="暂无条件项"
            description="添加条件项后，可供记忆变体、本圈默认条件与访问密钥默认语境选用。"
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
                  <span class="meta-k">唤醒别名：</span>
                  <span v-for="a in term.aliases" :key="a" class="alias-tag">{{ a }}</span>
                </p>
                <p v-if="impliesTags(term).length" class="term-meta">
                  <span class="meta-k">自动关联：</span>
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
                  :aria-label="`编辑条件项 ${term.label}`"
                  @click="openEditTerm(term)"
                />
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="text-muted hover:text-error"
                  :icon="icons.remove"
                  :aria-label="`删除条件项 ${term.label}`"
                  @click="((deletingTerm = term), (deleteTermError = null))"
                />
              </div>
            </li>
          </ul>
        </section>
      </div>
    </SettingsBlock>

    <UModal
      :open="dimModalOpen"
      :title="editingDim ? '编辑维度' : '新建维度'"
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
            <UInput
              v-model="dimForm.key"
              class="w-full font-mono"
              :disabled="editingDim !== null"
            />
          </UFormField>
          <UFormField label="维度名称">
            <UInput v-model="dimForm.name" placeholder="例如 业务领域" class="w-full" />
          </UFormField>
          <UFormField
            label="匹配模式"
            help="单选互斥维度在无交集时剔除启动冲突并降低召回权重；多选叠加维度仅加分不排斥"
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
        `维度 ${deletingDim?.key ?? ''} 及其下的全部条件项将一并删除。`,
        '若其他维度的条件项仍在自动关联中引用此维度，将无法删除。',
      ]"
      action="删除维度"
      :busy="deletingDimBusy"
      :error="deleteDimError"
      @close="deletingDim = null"
      @confirm="removeDimension"
    />

    <UModal
      :open="termModalOpen"
      :title="editingTerm ? '编辑条件项' : '新增条件项'"
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

          <UFormField label="唤醒别名" help="多个别名用逗号或换行分隔，每个 2 到 48 字">
            <UTextarea
              v-model="termForm.aliasesText"
              :rows="2"
              placeholder="例如 公司, 办公室, 加班"
              class="w-full"
            />
          </UFormField>

          <UFormField
            label="自动关联"
            help="命中此条件项时同时自动展开下列适用条件（成环将被服务端拒绝）"
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
      :title="`删除条件项「${deletingTerm?.label ?? ''}」？`"
      :consequences="[
        `条件项 ${deletingTerm?.slug ?? ''} 及其唤醒别名将被移除。`,
        '若有记忆变体或自动关联规则引用它，引用保留但不再展开此条件项名称。',
      ]"
      action="删除条件项"
      :busy="deletingTermBusy"
      :error="deleteTermError"
      @close="deletingTerm = null"
      @confirm="removeTerm"
    />
  </div>
</template>

<style scoped>
.vocab-box {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  margin-top: 8px;
  border: 1px solid var(--strata-rule);
}
.dim-list {
  border-right: 1px solid var(--strata-rule);
}
.dim-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 10px 12px;
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

.dim-detail {
  padding: 16px 20px 20px;
  min-width: 0;
}
.pane-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.pane-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.pane-title-row h3 {
  font-size: 16px;
  font-weight: 600;
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
  margin-top: 6px;
}
.term-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
}
.term-row:last-child {
  border-bottom: 0;
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

@media (max-width: 767.98px) {
  .vocab-box {
    grid-template-columns: minmax(0, 1fr);
  }
  .dim-list {
    border-right: 0;
    border-bottom: 1px solid var(--strata-rule);
  }
  .dim-detail {
    padding: 14px;
  }
}
</style>
