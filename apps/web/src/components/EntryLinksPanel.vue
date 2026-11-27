<script setup lang="ts">
import type { EntryLinkNeighbor } from '@kioku/contracts'
import { computed } from 'vue'

import { icons } from '../icons'
import { entryKindLabels } from '../labels'
import SectionHeading from './ui/SectionHeading.vue'
import WikiText from './ui/WikiText.vue'

type TitleSource =
  Readonly<Record<string, string>> | ReadonlyMap<string, { title: string } | string>

const props = withDefaults(
  defineProps<{
    outboundLinks: readonly EntryLinkNeighbor[]
    backlinks: readonly EntryLinkNeighbor[]
    titles?: TitleSource | null
    compact?: boolean
  }>(),
  { titles: null, compact: false },
)

const emit = defineEmits<{ open: [shortId: string] }>()

const resolvedTitles = computed<Map<string, { title: string }>>(() => {
  const map = new Map<string, { title: string }>()
  if (props.titles instanceof Map) {
    for (const [sid, val] of props.titles.entries()) {
      const title = typeof val === 'string' ? val : val.title
      if (title) map.set(sid, { title })
    }
  } else if (props.titles) {
    for (const [sid, title] of Object.entries(props.titles)) {
      if (title) map.set(sid, { title })
    }
  }
  for (const item of props.outboundLinks) map.set(item.shortId, { title: item.title })
  for (const item of props.backlinks) map.set(item.shortId, { title: item.title })
  return map
})
</script>

<template>
  <div v-if="outboundLinks.length || backlinks.length" class="links-panel" :class="{ compact }">
    <section v-if="outboundLinks.length" class="links-section">
      <SectionHeading title="出链" :icon="icons.promote" :level="3">
        <template #hint>
          <span class="links-count tabular-nums">{{ outboundLinks.length }}</span>
        </template>
      </SectionHeading>
      <ul class="links-list">
        <li v-for="item in outboundLinks" :key="`out-${item.shortId}`">
          <button
            type="button"
            class="link-row"
            :title="`${item.title}（${item.shortId}）`"
            @click="emit('open', item.shortId)"
          >
            <span class="link-head">
              <span class="link-title">{{ item.title }}</span>
              <span v-if="!compact" class="link-meta">{{ entryKindLabels[item.kind] }}</span>
            </span>
            <span v-if="item.relation || item.contextSnippet" class="link-context">
              <span v-if="item.relation" class="link-relation">{{ item.relation }}</span>
              <span v-if="item.relation && item.contextSnippet" aria-hidden="true"> · </span>
              <WikiText
                v-if="item.contextSnippet"
                :text="item.contextSnippet"
                :titles="resolvedTitles"
                :interactive="false"
                :mark-missing="false"
                strip-markdown
                compact
              />
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="backlinks.length" class="links-section">
      <SectionHeading title="反链" :icon="icons.backlink" :level="3">
        <template #hint>
          <span class="links-count tabular-nums">{{ backlinks.length }}</span>
        </template>
      </SectionHeading>
      <ul class="links-list">
        <li v-for="item in backlinks" :key="`in-${item.shortId}`">
          <button
            type="button"
            class="link-row"
            :title="`${item.title}（${item.shortId}）`"
            @click="emit('open', item.shortId)"
          >
            <span class="link-head">
              <span class="link-title">{{ item.title }}</span>
              <span v-if="!compact" class="link-meta">{{ entryKindLabels[item.kind] }}</span>
            </span>
            <span v-if="item.relation || item.contextSnippet" class="link-context">
              <span v-if="item.relation" class="link-relation">{{ item.relation }}</span>
              <span v-if="item.relation && item.contextSnippet" aria-hidden="true"> · </span>
              <WikiText
                v-if="item.contextSnippet"
                :text="item.contextSnippet"
                :titles="resolvedTitles"
                :interactive="false"
                :mark-missing="false"
                strip-markdown
                compact
              />
            </span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.links-panel {
  display: flex;
  flex-direction: column;
  gap: 18px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--ui-border);
}
.links-panel.compact {
  gap: 14px;
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
}
.links-panel.compact :deep(.section-head) {
  padding-bottom: 4px;
  border-bottom: 1px solid var(--ui-rule);
}
.links-panel.compact :deep(.section-title) {
  font-size: 12px;
  font-weight: 600;
}
.links-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.links-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}
.links-list {
  border-top: 1px solid var(--ui-border);
}
.link-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 7px 4px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  font-size: 14px;
  cursor: pointer;
}
.links-panel.compact .link-row {
  padding: 6px 2px;
  font-size: 13px;
}
.link-row:hover {
  background: var(--ui-bg-elevated);
}
.link-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.link-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ui-text-highlighted);
}
.link-meta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.link-context {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-muted);
}
.link-relation {
  color: var(--ui-text-toned);
  font-weight: 500;
}
</style>
