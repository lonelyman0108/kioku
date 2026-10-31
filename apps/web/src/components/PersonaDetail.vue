<script setup lang="ts">
import type { PersonaDetail, PersonaNode } from '@kioku/contracts'
import { computed } from 'vue'

import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import { sensitivityLabels } from '../labels'
import { overriddenNode } from '../memoryDetail'
import { inheritedGroups, lostFromBoot } from '../personas'
import { memoryRoute } from '../routes'
import Hint from './Hint.vue'
import MemoryRow from './strata/MemoryRow.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataStrip from './strata/StrataStrip.vue'
import UriPath from './strata/UriPath.vue'

const props = defineProps<{
  spaceId: string
  persona: PersonaDetail
  canEdit: boolean
}>()
defineEmits<{ edit: []; remove: []; open: [personaId: string] }>()

const copy = useCopy()
const rootUri = computed(() => `persona://${props.persona.slug}/`)
const nodes = computed(() => [...props.persona.own, ...props.persona.inherited])
// 被覆盖、而覆盖它的那条进不了启动上下文：会话开始时这个路径就没有了，提示一下
const lost = (node: PersonaNode) => lostFromBoot(node, nodes.value)
const groups = computed(() => inheritedGroups(props.persona))
const overrides = (uri: string) => overriddenNode(props.persona, uri)

// 删除人格会把它的人格层记忆连带硬删除，有引用时服务端会拒绝，界面先把原因列出来
const blockers = computed(() =>
  [
    props.persona.apps.length ? `${props.persona.apps.length} 个应用将其设为默认人格` : '',
    props.persona.children.length ? `${props.persona.children.length} 个人格继承此人格` : '',
    props.persona.storedMemories
      ? `仍有 ${props.persona.storedMemories} 条人格层记忆（含已删除）`
      : '',
  ].filter(Boolean),
)
const memoryLink = (uri: string) => memoryRoute(props.spaceId, uri)
</script>

<template>
  <article class="persona-detail">
    <StrataStrip layer="persona" sensitivity="public" />
    <header class="detail-head">
      <div class="detail-nav"><slot name="nav" /></div>
      <h1>{{ persona.name }}</h1>
      <div class="detail-uri">
        <span>{{ rootUri }}</span>
        <UButton
          :icon="icons.copy"
          size="xs"
          color="neutral"
          variant="ghost"
          aria-label="复制 URI"
          @click="copy(rootUri)"
        />
      </div>
      <p v-if="persona.description" class="detail-description">{{ persona.description }}</p>
      <p v-if="canEdit && blockers.length" class="detail-blocked">
        无法删除：{{ blockers.join('；') }}
      </p>
      <div v-if="canEdit" class="detail-actions">
        <UButton size="sm" @click="$emit('edit')">修改</UButton>
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
      <div class="detail-nodes">
        <section>
          <SectionHeading title="自己的节点">
            <template #actions>
              <b class="count">{{ persona.own.length }}</b>
            </template>
          </SectionHeading>
          <ul v-if="persona.own.length">
            <li v-for="node in persona.own" :key="node.uri">
              <MemoryRow
                flush
                :uri="node.uri"
                layer="persona"
                :sensitivity="node.sensitivity"
                :to="memoryLink(node.uri)"
              >
                <template #flags>
                  <span class="node-flags">
                    <span>{{ sensitivityLabels[node.sensitivity] }}</span>
                    <b>P{{ node.priority }}</b>
                  </span>
                </template>
                <span v-if="node.disclosure" class="block">{{ node.disclosure }}</span>
                <span v-if="overrides(node.uri)" class="block">
                  覆盖「{{ overrides(node.uri)!.persona }}」的同名节点
                </span>
              </MemoryRow>
            </li>
          </ul>
          <p v-else class="empty">
            暂无节点。设定写在 <code>{{ rootUri }}</code> 下的记忆中。
          </p>
        </section>

        <section v-if="persona.ancestors.length">
          <SectionHeading title="继承来的节点">
            <template #hint>
              <Hint>
                相同相对路径上，继承链中更近的人格节点覆盖祖先节点。被覆盖的节点不进入启动加载与召回，仍可按
                URI 读取。
              </Hint>
            </template>
            <template #actions>
              <b class="count">{{ persona.inherited.length }}</b>
            </template>
          </SectionHeading>
          <template v-if="groups.length">
            <div v-for="group in groups" :key="group.id">
              <h3 class="group-name">来自 {{ group.name }}</h3>
              <ul>
                <li v-for="node in group.nodes" :key="node.uri">
                  <MemoryRow
                    flush
                    :class="{ overridden: node.overriddenBy }"
                    :uri="node.uri"
                    layer="persona"
                    :sensitivity="node.sensitivity"
                    :to="memoryLink(node.uri)"
                  >
                    <template #flags>
                      <span class="node-flags">
                        <span>{{ sensitivityLabels[node.sensitivity] }}</span>
                        <b>P{{ node.priority }}</b>
                      </span>
                    </template>
                    <span v-if="node.overriddenBy" class="node-by">
                      已被
                      <RouterLink :to="memoryLink(node.overriddenBy)">
                        <UriPath :uri="node.overriddenBy" />
                      </RouterLink>
                      覆盖
                    </span>
                    <span v-else-if="node.disclosure" class="block">{{ node.disclosure }}</span>
                    <span v-if="lost(node)" class="block text-warning">
                      此节点本应进入启动加载，但覆盖它的节点优先级为 P{{
                        lost(node)
                      }}，无法进入启动加载，会话开始时此路径将缺失。
                    </span>
                  </MemoryRow>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="empty">祖先人格暂无节点</p>
        </section>
      </div>

      <aside class="detail-side">
        <section>
          <SectionHeading title="继承" />
          <!-- 当前人格压在最上面，往下是更远的祖先，和地层柱一个读法 -->
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
          <SectionHeading title="使用此人格的应用" />
          <ul v-if="persona.apps.length">
            <li v-for="app in persona.apps" :key="app.id" class="side-row">
              <RouterLink
                :to="{ name: 'app', params: { spaceId, appId: app.id } }"
                class="side-name link"
              >
                {{ app.name }}
              </RouterLink>
              <span class="side-code">app://{{ app.slug }}</span>
            </li>
          </ul>
          <p v-else class="side-empty">暂无应用将其设为默认人格</p>
        </section>
      </aside>
    </div>
  </article>
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
.detail-head h1 {
  font-size: 21px;
  font-weight: 500;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.detail-uri {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
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
  gap: 6px;
}
.persona-detail > .detail-main {
  flex: 1 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 290px;
  align-items: stretch;
}
.detail-nodes {
  min-width: 0;
  padding: 20px 40px 48px 32px;
}
.detail-nodes section + section {
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
.node-flags {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--ui-text-muted);
}
.node-flags b {
  min-width: 2ch;
  font-family: var(--font-mono);
  font-weight: 500;
  text-align: right;
}
.overridden :deep(.row-swatch) {
  opacity: 0.5;
}
.overridden :deep(.row-link) {
  --uri-parent: var(--ui-text-dimmed);
  color: var(--ui-text-dimmed);
}
.overridden :deep(.row-link .uri-parent),
.overridden :deep(.row-link .uri-leaf) {
  text-decoration: line-through;
}
.node-by {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 5px;
  min-width: 0;
}
.node-by a {
  min-width: 0;
  max-width: 100%;
  font-size: 14px;
  color: var(--ui-text-toned);
}
.node-by a:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
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

/* 放不下两栏时，继承关系放到节点下面，操作放到标题下面 */
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
  }
  .detail-nodes {
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
  .detail-nodes {
    padding: 16px 16px 24px;
  }
  .detail-side {
    padding: 16px 16px 32px;
  }
}
</style>
