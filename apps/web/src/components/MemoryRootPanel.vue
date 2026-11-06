<script setup lang="ts">
import { SENSITIVITIES, sensitivityAllowed, type CuratedLayer } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { api } from '../api/endpoints'
import { coordinateHead } from '../coordinates'
import { layerLabels, sensitivityLabels } from '../labels'
import { personaRows } from '../personas'
import Hint from './Hint.vue'
import CoordinateLine from './strata/CoordinateLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'
import StrataSwatch from './strata/StrataSwatch.vue'
import { layerHints, layerTotal, type StrataCounts } from './strata/strata'

// 记忆目录里选中一个根（本人、应用、人格、通用）时右边的内容：各敏感级有多少条，
// 人格与应用的根列出各个人格、应用。适用范围只放在标题旁的提示层里
const props = defineProps<{
  spaceId: string
  layer: CuratedLayer
  counts: StrataCounts | null
  canWrite: boolean
  canEditPersonas: boolean
}>()
const emit = defineEmits<{
  create: []
  createPersona: []
  openPersona: [personaId: string]
  openApp: [appId: string]
}>()

const personas = useQuery({
  queryKey: computed(() => ['personas', props.spaceId]),
  queryFn: () => api.personas(props.spaceId),
  enabled: computed(() => props.layer === 'persona'),
})
const apps = useQuery({
  queryKey: computed(() => ['apps', props.spaceId]),
  queryFn: () => api.apps(props.spaceId),
  enabled: computed(() => props.layer === 'persona' || props.layer === 'app'),
})
const personaList = computed(() => personaRows(personas.data.value ?? []))
const personaName = (id: string | null) =>
  id ? (personas.data.value?.find((p) => p.id === id)?.name ?? null) : null
const appsOf = (personaId: string) =>
  (apps.data.value ?? []).filter((a) => a.defaultPersonaId === personaId).map((a) => a.name)

// 坐标的开头：人格与应用的开头里还有人格或应用的标识
const head = computed(() =>
  props.layer === 'persona' || props.layer === 'app'
    ? coordinateHead(props.layer, `<${layerLabels[props.layer]}标识>`)
    : coordinateHead(props.layer, null),
)
// 本人不设公开，那一档不列
const levels = computed(() => SENSITIVITIES.filter((s) => sensitivityAllowed(props.layer, s)))
const total = computed(() => (props.counts ? layerTotal(props.counts, props.layer) : null))

const titleEl = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => titleEl.value?.focus() })
</script>

<template>
  <article class="root-panel">
    <StrataStrip :layer="layer" :sensitivity="layer === 'user' ? 'private' : 'public'" />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <h1 ref="titleEl" tabindex="-1">
        {{ layerLabels[layer] }}<Hint>{{ layerHints[layer] }}</Hint>
      </h1>
      <p class="detail-meta">
        <template v-if="total !== null">记忆 {{ total }} 条</template>
      </p>
      <div v-if="canWrite || (layer === 'persona' && canEditPersonas)" class="detail-actions">
        <UButton v-if="canWrite" size="sm" @click="emit('create')">新建记忆</UButton>
        <UButton
          v-if="layer === 'persona' && canEditPersonas"
          size="sm"
          color="primary"
          variant="outline"
          @click="emit('createPersona')"
        >
          新建人格
        </UButton>
      </div>
    </header>

    <div class="detail-body">
      <section v-if="counts">
        <SectionHeading title="敏感级" />
        <ul class="levels">
          <li v-for="s in levels" :key="s">
            <StrataSwatch :layer="layer" :sensitivity="s" decorative />
            <span class="level-name">{{ sensitivityLabels[s] }}</span>
            <span class="level-count">{{ counts[layer][s] }}</span>
          </li>
        </ul>
      </section>

      <section v-if="layer === 'persona'">
        <SectionHeading title="人格">
          <template #hint>
            <Hint
              >子人格继承上一级，相同位置与标识的记忆以子人格的为准。应用的默认人格在「接入 ›
              应用」中选择。</Hint
            >
          </template>
          <template #actions>
            <b v-if="personas.data.value" class="count">{{ personas.data.value.length }}</b>
          </template>
        </SectionHeading>
        <ReadFailureNote v-if="personas.isError.value" :query="personas" size="xs" />
        <USkeleton v-if="personas.isPending.value" class="mt-2 h-16 w-full" />
        <ul v-else-if="personaList.length">
          <li v-for="row in personaList" :key="row.persona.id" class="side-row">
            <button type="button" class="side-name" @click="emit('openPersona', row.persona.id)">
              {{ row.persona.name }}
            </button>
            <span class="side-meta">
              <template v-if="personaName(row.persona.extendsId)">
                继承{{ personaName(row.persona.extendsId) }} ·
              </template>
              {{
                appsOf(row.persona.id).length
                  ? `用在 ${appsOf(row.persona.id).join('、')}`
                  : '暂无应用使用'
              }}
            </span>
          </li>
        </ul>
        <p v-else-if="personas.data.value" class="empty">暂无人格</p>
      </section>

      <section v-if="layer === 'app'">
        <SectionHeading title="应用">
          <template #actions>
            <RouterLink :to="{ name: 'apps', params: { spaceId } }" class="heading-link">
              管理应用
            </RouterLink>
          </template>
        </SectionHeading>
        <ReadFailureNote v-if="apps.isError.value" :query="apps" size="xs" />
        <USkeleton v-if="apps.isPending.value" class="mt-2 h-16 w-full" />
        <ul v-else-if="apps.data.value?.length">
          <li v-for="a in apps.data.value" :key="a.id" class="side-row">
            <button type="button" class="side-name" @click="emit('openApp', a.id)">
              {{ a.name }}
            </button>
            <span class="side-meta">{{ a.runtimeFamily }}</span>
          </li>
        </ul>
        <p v-else-if="apps.data.value" class="empty">暂无应用</p>
      </section>

      <p v-if="layer === 'user'" class="foot-note">
        凭据占位符只能写在本人、敏感级不低于私密的记忆中。
        <RouterLink :to="{ name: 'credentials', params: { spaceId } }" class="heading-link">
          查看凭据
        </RouterLink>
      </p>
    </div>

    <CoordinateLine :value="head" label="坐标开头" />
  </article>
</template>

<style scoped>
.root-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}
.root-panel > * {
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
.detail-head h1 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
}
.detail-head h1:focus {
  outline: 0;
}
.detail-meta {
  margin-top: 3px;
  min-height: 1.6em;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.detail-head > .detail-actions {
  grid-column: 2;
  grid-row: 1 / span 3;
  align-self: start;
  display: flex;
  gap: 6px;
}
.detail-body {
  flex: 1 0 auto;
  padding: 20px 32px 40px;
}
.detail-body section + section,
.detail-body section + .foot-note {
  margin-top: 26px;
}
.levels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  padding-top: 10px;
}
.levels li {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
}
.level-count {
  font-family: var(--font-mono);
  font-weight: 600;
}
.count {
  font-family: var(--font-mono);
  font-weight: 600;
}
.empty {
  padding: 10px 0;
  color: var(--ui-text-muted);
}
.side-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 10px;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--ui-border);
}
.side-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  text-align: left;
  overflow-wrap: anywhere;
}
.side-name:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.side-meta {
  font-size: 13px;
  color: var(--ui-text-muted);
}
.heading-link {
  color: var(--ui-text-muted);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 70%, transparent);
  text-underline-offset: 3px;
}
.heading-link:hover {
  color: var(--ui-text-highlighted);
}
.foot-note {
  line-height: 1.6;
  color: var(--ui-text-muted);
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
}
@media (max-width: 1023.98px) {
  .detail-head {
    padding: 12px 16px 14px;
  }
  .detail-head h1 {
    font-size: 18px;
  }
  .detail-body {
    padding: 16px 16px 32px;
  }
}
</style>
