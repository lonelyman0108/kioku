<script setup lang="ts">
import { computed, getCurrentInstance } from 'vue'
import { useRouter } from 'vue-router'

import { icons } from '../../icons'
import { splitWikiLinks } from '../../markdown'
import { entryRoute } from '../../routes'

type WikiTitleSource =
  Readonly<Record<string, string>> | ReadonlyMap<string, { title: string } | string>

interface RenderedSegment {
  text: string
  link?: {
    shortId: string
    label: string
    tooltip: string
    missing: boolean
  }
}

// 将含 [[m-xxxxxx]] / [[m-xxxxxx|别名]] 的纯文本渲染为「正文 + 行内双链芯片」
const props = withDefaults(
  defineProps<{
    text: string
    titles?: WikiTitleSource | null
    interactive?: boolean
    compact?: boolean
    markMissing?: boolean
  }>(),
  {
    titles: null,
    interactive: true,
    compact: false,
    markMissing: true,
  },
)

const emit = defineEmits<{ open: [shortId: string] }>()

const router = useRouter()
const instance = getCurrentInstance()

function lookupTitle(titles: WikiTitleSource | null | undefined, shortId: string): string | null {
  if (!titles) return null
  if (titles instanceof Map) {
    const value = titles.get(shortId)
    if (typeof value === 'string') return value || null
    return value?.title || null
  }
  const record = titles as Readonly<Record<string, string>>
  if (!Object.hasOwn(record, shortId)) return null
  return record[shortId] || null
}

const segments = computed<RenderedSegment[]>(() => {
  const hasTitles = props.titles != null
  return splitWikiLinks(props.text).map((seg) => {
    if (!seg.link) return { text: seg.text }
    const { shortId, alias } = seg.link
    const resolvedTitle = lookupTitle(props.titles, shortId)
    return {
      text: seg.text,
      link: {
        shortId,
        label: alias ?? resolvedTitle ?? shortId,
        tooltip: resolvedTitle ? `${resolvedTitle}（${shortId}）` : shortId,
        missing: props.markMissing && hasTitles && !resolvedTitle,
      },
    }
  })
})

function hrefOf(shortId: string): string {
  if (router) return router.resolve(entryRoute(shortId)).href
  return `/memories?id=${encodeURIComponent(shortId)}`
}

function hasOpenListener(): boolean {
  return Boolean(instance?.vnode.props?.onOpen)
}

function onChipClick(shortId: string, event: MouseEvent) {
  event.stopPropagation()
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
    return
  }
  event.preventDefault()
  if (hasOpenListener()) {
    emit('open', shortId)
  } else if (router) {
    void router.push(entryRoute(shortId))
  }
}
</script>

<template>
  <span class="wiki-text">
    <template v-for="(seg, idx) in segments" :key="idx">
      <template v-if="!seg.link">{{ seg.text }}</template>
      <a
        v-else-if="interactive"
        :href="hrefOf(seg.link.shortId)"
        class="wiki-chip"
        :class="{ 'is-compact': compact, 'is-missing': seg.link.missing }"
        :data-short-id="seg.link.shortId"
        :title="seg.link.tooltip"
        @click="onChipClick(seg.link.shortId, $event)"
        ><UIcon :name="icons.linkChain" class="wiki-chip-icon" aria-hidden="true" /><span
          class="wiki-chip-label"
          >{{ seg.link.label }}</span
        ></a
      >
      <span
        v-else
        class="wiki-chip is-static"
        :class="{ 'is-compact': compact, 'is-missing': seg.link.missing }"
        :data-short-id="seg.link.shortId"
        :title="seg.link.tooltip"
        ><UIcon :name="icons.linkChain" class="wiki-chip-icon" aria-hidden="true" /><span
          class="wiki-chip-label"
          >{{ seg.link.label }}</span
        ></span
      >
    </template>
  </span>
</template>

<style scoped>
.wiki-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  margin: 0 1px;
  padding: 0 5px;
  border: 1px solid var(--wiki-chip-border, var(--ui-border-accented));
  background: var(--wiki-chip-bg, var(--ui-bg-muted));
  color: var(--wiki-chip-fg, var(--ui-text-highlighted));
  font-size: inherit;
  line-height: 1.4;
  text-decoration: none;
  vertical-align: -1px;
}
a.wiki-chip {
  cursor: pointer;
}
a.wiki-chip:hover {
  border-color: var(--wiki-chip-hover-border, var(--ui-rule));
  background: var(--wiki-chip-hover-bg, var(--ui-bg-elevated));
}
.wiki-chip.is-static {
  cursor: inherit;
}
.wiki-chip.is-compact {
  padding: 0 4px;
  gap: 3px;
  line-height: 1.35;
  vertical-align: baseline;
}
.wiki-chip.is-missing {
  border-style: dashed;
  color: var(--wiki-chip-missing-fg, var(--ui-text-muted));
}
.wiki-chip-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--wiki-chip-icon, var(--ui-text-muted));
}
a.wiki-chip:hover .wiki-chip-icon {
  color: var(--wiki-chip-hover-icon, var(--ui-text-highlighted));
}
a.wiki-chip.is-missing:hover .wiki-chip-icon {
  color: var(--wiki-chip-missing-fg, var(--ui-text-muted));
}
.wiki-chip-label {
  min-width: 0;
  overflow-wrap: anywhere;
}
.wiki-chip.is-compact .wiki-chip-label {
  max-width: var(--wiki-chip-max-width, 16em);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
