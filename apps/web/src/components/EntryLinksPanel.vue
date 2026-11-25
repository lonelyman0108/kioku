<script setup lang="ts">
import type { EntryLinkNeighbor } from '@kioku/contracts'

import { entryKindLabels } from '../labels'
import SectionHeading from './ui/SectionHeading.vue'

defineProps<{
  outboundLinks: readonly EntryLinkNeighbor[]
  backlinks: readonly EntryLinkNeighbor[]
}>()

const emit = defineEmits<{ open: [shortId: string] }>()
</script>

<template>
  <div v-if="outboundLinks.length || backlinks.length" class="links-panel">
    <section v-if="outboundLinks.length" class="links-section">
      <SectionHeading title="出链" :level="3" />
      <ul class="links-list">
        <li v-for="item in outboundLinks" :key="`out-${item.shortId}`">
          <button type="button" class="link-row" @click="emit('open', item.shortId)">
            <span class="link-title">{{ item.title }}</span>
            <span class="link-meta">
              <span class="font-mono">{{ item.shortId }}</span>
              <span>{{ entryKindLabels[item.kind] }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section v-if="backlinks.length" class="links-section">
      <SectionHeading title="反向链接" :level="3" />
      <ul class="links-list">
        <li v-for="item in backlinks" :key="`in-${item.shortId}`">
          <button type="button" class="link-row" @click="emit('open', item.shortId)">
            <span class="link-title">{{ item.title }}</span>
            <span class="link-meta">
              <span class="font-mono">{{ item.shortId }}</span>
              <span>{{ entryKindLabels[item.kind] }}</span>
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
.links-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.links-list {
  border-top: 1px solid var(--ui-border);
}
.link-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 7px 4px;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
  font-size: 14px;
  cursor: pointer;
}
.link-row:hover {
  background: var(--ui-bg-elevated);
}
.link-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-meta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
</style>
