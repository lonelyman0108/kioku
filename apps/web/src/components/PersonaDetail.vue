<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  TraitKey,
  UpsertPersonaTraitRequest,
  type PersonaDetail,
  type PersonaInfo,
  type ResolvedPersonaTrait,
} from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { inheritedGroups } from '../personas'
import { formatRelative, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'

// 独立人格详情：管理按 traitKey 组织的自有设定段，展示继承设定段与覆盖状态，以及绑定此人格的接入实例
const props = defineProps<{
  circleId: string
  persona: PersonaDetail
  personas: readonly PersonaInfo[]
  canEdit: boolean
}>()
defineEmits<{
  edit: []
  remove: []
  open: [personaId: string]
}>()

const toast = useToast()
const queryClient = useQueryClient()

const groups = computed(() => inheritedGroups(props.persona))

const blockers = computed(() =>
  [
    props.persona.clients.length
      ? `${props.persona.clients.length} 个接入实例将其设为默认人格`
      : '',
    props.persona.children.length ? `${props.persona.children.length} 个人格继承此人格` : '',
  ].filter(Boolean),
)

const personaNameMap = computed(() => {
  const map = new Map<string, string>()
  map.set(props.persona.id, props.persona.name)
  for (const a of props.persona.ancestors) map.set(a.id, a.name)
  for (const p of props.personas) map.set(p.id, p.name)
  return map
})

function overriddenByLabel(overriddenBy: string | null): string {
  if (!overriddenBy) return ''
  if (overriddenBy === props.persona.id) return '当前人格'
  return personaNameMap.value.get(overriddenBy) ?? '子级或本级人格'
}

const ownKeys = computed(() => new Set(props.persona.ownTraits.map((t) => t.traitKey)))

// 设定段新增/编辑/覆盖弹窗
const traitModalOpen = ref(false)
const keyLocked = ref(false)
const editingKey = ref<string | null>(null)
const traitForm = reactive({
  traitKey: '',
  title: '',
  content: '',
  sortOrder: 0,
})
const traitError = ref<string | null>(null)
const savingTrait = ref(false)

function openCreateTrait() {
  keyLocked.value = false
  editingKey.value = null
  traitForm.traitKey = ''
  traitForm.title = ''
  traitForm.content = ''
  traitForm.sortOrder = (props.persona.ownTraits.length + 1) * 10
  traitError.value = null
  traitModalOpen.value = true
}

function openEditTrait(trait: ResolvedPersonaTrait) {
  keyLocked.value = true
  editingKey.value = trait.traitKey
  traitForm.traitKey = trait.traitKey
  traitForm.title = trait.title
  traitForm.content = trait.content
  traitForm.sortOrder = trait.sortOrder
  traitError.value = null
  traitModalOpen.value = true
}

function openOverrideTrait(trait: ResolvedPersonaTrait) {
  keyLocked.value = true
  editingKey.value = null
  traitForm.traitKey = trait.traitKey
  traitForm.title = trait.title
  traitForm.content = trait.content
  traitForm.sortOrder = trait.sortOrder
  traitError.value = null
  traitModalOpen.value = true
}

const traitProblem = computed(() => {
  if (!keyLocked.value) {
    const keyRes = TraitKey.safeParse(traitForm.traitKey)
    if (!keyRes.success) return keyRes.error.issues[0]?.message ?? '设定键格式有误'
  }
  const parsed = UpsertPersonaTraitRequest.safeParse({
    traitKey: traitForm.traitKey,
    title: traitForm.title,
    content: traitForm.content,
    sortOrder: Number(traitForm.sortOrder),
  })
  if (!parsed.success) return parsed.error.issues[0]?.message ?? '设定内容有误'
  return null
})

async function saveTrait() {
  if (savingTrait.value || traitProblem.value) return
  savingTrait.value = true
  traitError.value = null
  try {
    await api.upsertPersonaTrait(props.circleId, props.persona.id, {
      traitKey: traitForm.traitKey.trim().toLowerCase(),
      title: traitForm.title.trim(),
      content: traitForm.content,
      sortOrder: Number(traitForm.sortOrder),
    })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['persona', props.circleId, props.persona.id] }),
      queryClient.invalidateQueries({ queryKey: ['personas', props.circleId] }),
    ])
    toast.add({ title: editingKey.value ? '已保存设定段' : '已添加设定段', color: 'success' })
    traitModalOpen.value = false
  } catch (err) {
    traitError.value = err instanceof ApiError ? err.message : '保存失败'
  } finally {
    savingTrait.value = false
  }
}

// 删除自有设定段
const deletingTrait = ref<ResolvedPersonaTrait | null>(null)
const deletingTraitBusy = ref(false)
const deleteTraitError = ref<string | null>(null)

async function removeTrait() {
  const target = deletingTrait.value
  if (!target || deletingTraitBusy.value) return
  deletingTraitBusy.value = true
  deleteTraitError.value = null
  try {
    await api.deletePersonaTrait(props.circleId, props.persona.id, target.traitKey)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['persona', props.circleId, props.persona.id] }),
      queryClient.invalidateQueries({ queryKey: ['personas', props.circleId] }),
    ])
    deletingTrait.value = null
    toast.add({ title: '已删除设定段', color: 'success' })
  } catch (err) {
    deleteTraitError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deletingTraitBusy.value = false
  }
}

// 窄屏上打开之后，页面把焦点放到标题
const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <article class="persona-detail">
    <StrataStrip band="persona" sensitivity="public" />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <div class="detail-title-row">
        <h1 ref="titleEl" tabindex="-1">{{ persona.name }}</h1>
        <code class="detail-slug">{{ persona.slug }}</code>
      </div>
      <p v-if="persona.description" class="detail-description">{{ persona.description }}</p>
      <p v-if="canEdit && blockers.length" class="detail-blocked">
        无法删除：{{ blockers.join('；') }}
      </p>
      <div v-if="canEdit" class="detail-actions">
        <UButton size="sm" :icon="icons.add" @click="openCreateTrait">新增设定段</UButton>
        <UButton size="sm" color="primary" variant="outline" @click="$emit('edit')">
          修改人格
        </UButton>
        <UButton
          size="sm"
          color="error"
          variant="outline"
          :disabled="blockers.length > 0"
          @click="$emit('remove')"
        >
          删除
        </UButton>
      </div>
    </header>

    <div class="detail-main">
      <div class="detail-traits">
        <!-- 使用方放的状态提示，比如后台刷新失败 -->
        <slot name="notice" />

        <section>
          <SectionHeading title="自有设定段">
            <template #hint>
              <Hint>
                设定段按设定键组织；子人格若定义同名设定键，会在继承链中覆盖本级定义，并在会话开始时直接注入生效版本。
              </Hint>
            </template>
            <template #actions>
              <b class="count">{{ persona.ownTraits.length }}</b>
            </template>
          </SectionHeading>
          <ul v-if="persona.ownTraits.length">
            <li v-for="trait in persona.ownTraits" :key="trait.traitKey" class="trait-row">
              <div class="trait-head">
                <span class="trait-title">{{ trait.title }}</span>
                <code class="trait-key">{{ trait.traitKey }}</code>
                <span class="trait-order">顺序 {{ trait.sortOrder }}</span>
                <time
                  class="trait-time"
                  :datetime="trait.updatedAt"
                  :title="formatTime(trait.updatedAt)"
                >
                  {{ formatRelative(trait.updatedAt) }}
                </time>
                <div v-if="canEdit" class="trait-actions">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.edit"
                    :aria-label="`编辑设定段 ${trait.title}`"
                    @click="openEditTrait(trait)"
                  />
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    class="text-muted hover:text-error"
                    :icon="icons.remove"
                    :aria-label="`删除设定段 ${trait.title}`"
                    @click="((deletingTrait = trait), (deleteTraitError = null))"
                  />
                </div>
              </div>
              <p class="trait-content">{{ trait.content }}</p>
            </li>
          </ul>
          <p v-else class="empty">暂无自有设定段</p>
        </section>

        <section v-if="persona.ancestors.length">
          <SectionHeading title="继承的设定段">
            <template #hint>
              <Hint>
                相同设定键上，继承链中更近的人格覆盖祖先的设定段。点击「覆盖此设定段」可在本级写入同名设定键。
              </Hint>
            </template>
            <template #actions>
              <b class="count">{{ persona.inheritedTraits.length }}</b>
            </template>
          </SectionHeading>
          <template v-if="groups.length">
            <div v-for="group in groups" :key="group.persona.id">
              <h3 class="group-name">继承自 {{ group.persona.name }}</h3>
              <ul>
                <li
                  v-for="trait in group.traits"
                  :key="`${group.persona.id}:${trait.traitKey}`"
                  class="trait-row inherited"
                  :class="{ overridden: trait.overriddenBy !== null }"
                >
                  <div class="trait-head">
                    <span class="trait-title">{{ trait.title }}</span>
                    <code class="trait-key">{{ trait.traitKey }}</code>
                    <span v-if="trait.overriddenBy" class="trait-overridden">
                      已被「{{ overriddenByLabel(trait.overriddenBy) }}」覆盖
                    </span>
                    <UButton
                      v-else-if="canEdit && !ownKeys.has(trait.traitKey)"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      class="ml-auto"
                      @click="openOverrideTrait(trait)"
                    >
                      覆盖此设定段
                    </UButton>
                  </div>
                  <p class="trait-content">{{ trait.content }}</p>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="empty">祖先人格暂无设定段</p>
        </section>
      </div>

      <aside class="detail-side">
        <section>
          <SectionHeading title="继承链" />
          <!-- 当前人格压在最上面，往下是更远的祖先 -->
          <ol class="chain" aria-label="继承链，从当前人格到最远的祖先">
            <li class="chain-row current">
              <i class="chain-band" aria-hidden="true" />
              <span class="chain-name">{{ persona.name }}</span>
              <span class="chain-flag">当前</span>
            </li>
            <li v-for="ancestor in persona.ancestors" :key="ancestor.id" class="chain-row">
              <i class="chain-band" aria-hidden="true" />
              <button type="button" class="chain-name link" @click="$emit('open', ancestor.id)">
                {{ ancestor.name }}
              </button>
            </li>
          </ol>
          <p v-if="!persona.ancestors.length" class="side-empty">未继承其他人格</p>
        </section>

        <section>
          <SectionHeading title="子人格" />
          <ul v-if="persona.children.length">
            <li v-for="child in persona.children" :key="child.id" class="side-row">
              <button type="button" class="side-name link" @click="$emit('open', child.id)">
                {{ child.name }}
              </button>
              <span class="side-code">{{ child.slug }}</span>
            </li>
          </ul>
          <p v-else class="side-empty">暂无子人格</p>
        </section>

        <section>
          <SectionHeading title="使用此人格的接入实例" />
          <ul v-if="persona.clients.length">
            <li v-for="client in persona.clients" :key="client.id" class="side-row">
              <RouterLink
                :to="{ name: 'client', params: { circleId, clientId: client.id } }"
                class="side-name link"
              >
                {{ client.name }}
              </RouterLink>
              <span class="side-code">{{ client.slug }}</span>
            </li>
          </ul>
          <p v-else class="side-empty">暂无接入实例将其设为默认人格</p>
        </section>
      </aside>
    </div>
  </article>

  <UModal
    :open="traitModalOpen"
    :title="editingKey ? '修改设定段' : keyLocked ? '覆盖继承的设定段' : '新增设定段'"
    :dismissible="!savingTrait"
    :close="!savingTrait"
    :ui="{ content: 'sm:max-w-xl' }"
    @update:open="(v) => !v && !savingTrait && (traitModalOpen = false)"
  >
    <template #body>
      <!-- 不用 form：输入框回车显式点保存 -->
      <div class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <UFormField label="设定键" help="小写字母、数字、_ 或 -，例如 tone、rules">
            <UInput v-model="traitForm.traitKey" class="w-full font-mono" :disabled="keyLocked" />
          </UFormField>
          <UFormField label="排序权重" help="数字越小越靠前注入">
            <UInput
              v-model.number="traitForm.sortOrder"
              type="number"
              min="0"
              max="999"
              class="w-full font-mono"
            />
          </UFormField>
        </div>
        <UFormField label="标题">
          <UInput v-model="traitForm.title" placeholder="例如 说话语气与称呼习惯" class="w-full" />
        </UFormField>
        <UFormField label="设定正文">
          <UTextarea v-model="traitForm.content" :rows="6" class="w-full" />
        </UFormField>
        <NoteLine v-if="traitError" tone="error" flush>{{ traitError }}</NoteLine>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="savingTrait"
          @click="traitModalOpen = false"
        >
          取消
        </UButton>
        <UButton :disabled="Boolean(traitProblem)" :loading="savingTrait" @click="saveTrait">
          保存
        </UButton>
      </div>
    </template>
  </UModal>

  <ConsequenceModal
    :open="deletingTrait !== null"
    :title="`删除设定段「${deletingTrait?.title ?? ''}」？`"
    :consequences="[
      `设定键 ${deletingTrait?.traitKey ?? ''} 将从当前人格删除。`,
      '若祖先人格定义了同名设定键，此人格及子人格将恢复继承祖先的版本。',
    ]"
    action="删除设定段"
    :busy="deletingTraitBusy"
    :error="deleteTraitError"
    @close="deletingTrait = null"
    @confirm="removeTrait"
  />
</template>

<style scoped>
.persona-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.persona-detail > * {
  flex: none;
}
.detail-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  column-gap: 24px;
  padding: 14px 32px 15px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.detail-head > * {
  grid-column: 1;
}
.detail-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
}
.detail-head h1 {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-head h1:focus {
  outline: 0;
}
.detail-slug {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
}
.detail-description {
  margin-top: 5px;
  line-height: 1.6;
}
.detail-blocked {
  margin-top: 3px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.detail-head > .detail-actions {
  grid-column: 2;
  grid-row: 1 / span 5;
  align-self: start;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.persona-detail > .detail-main {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  align-items: stretch;
}
.detail-traits {
  min-width: 0;
  padding: 20px 40px 48px 32px;
}
.detail-traits section + section {
  margin-top: 26px;
}
.detail-side {
  min-width: 0;
  padding: 20px 32px 40px 20px;
  border-left: 1px solid var(--ui-border);
}
.detail-side section + section {
  margin-top: 24px;
}
.count {
  font-family: var(--font-mono);
  font-weight: 600;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.group-name {
  padding: 12px 0 5px;
  border-bottom: 1px solid var(--ui-border-accented);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.trait-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--ui-border);
}
.trait-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.trait-title {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}
.trait-key {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.trait-order,
.trait-time,
.trait-overridden {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.trait-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}
.trait-content {
  margin-top: 5px;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.inherited .trait-title,
.inherited .trait-content {
  color: var(--ui-text-muted);
}
.overridden .trait-title {
  color: var(--ui-text-dimmed);
  text-decoration: line-through;
}
.overridden .trait-content {
  color: var(--ui-text-dimmed);
}

/* 继承链：一摞带，当前人格满色，祖先淡一级 */
.chain {
  padding-top: 10px;
}
.chain-row {
  display: grid;
  grid-template-columns: 18px 9px minmax(0, 1fr) auto;
  align-items: center;
  min-height: 32px;
}
.chain-row::before {
  content: '';
  grid-column: 2;
  grid-row: 1;
  height: 1px;
  background: var(--strata-rule);
}
.chain-band {
  grid-column: 1;
  grid-row: 1;
  align-self: stretch;
  border: 1px solid var(--strata-frame);
  background: color-mix(in srgb, var(--layer-persona) var(--strata-tint), var(--ui-bg));
}
.chain-row + .chain-row .chain-band {
  border-top: 0;
}
.current .chain-band {
  background: var(--layer-persona);
}
.chain-name {
  grid-column: 3;
  min-width: 0;
  padding-left: 6px;
  font-size: 14px;
  line-height: 1.4;
  text-align: left;
  overflow-wrap: anywhere;
}
.current .chain-name {
  font-weight: 600;
}
.chain-flag {
  grid-column: 4;
  padding-left: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.side-empty {
  padding: 9px 0;
  color: var(--ui-text-muted);
}
.side-row {
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
}
.side-name {
  display: block;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  text-align: left;
  overflow-wrap: anywhere;
}
.side-code {
  display: block;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.link:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 1240px) {
  .detail-head {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-head > .detail-actions {
    grid-column: 1;
    grid-row: auto;
    margin-top: 11px;
  }
  .persona-detail > .detail-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto 1fr;
  }
  .detail-traits {
    padding-bottom: 28px;
  }
  .detail-side {
    padding: 18px 32px 40px;
    border-left: 0;
    border-top: 1px solid var(--ui-border-accented);
  }
}
@media (max-width: 1023.98px) {
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-head h1 {
    font-size: 18px;
  }
  .detail-traits {
    padding: 16px 16px 24px;
  }
  .detail-side {
    padding: 16px 16px 32px;
  }
}
</style>
