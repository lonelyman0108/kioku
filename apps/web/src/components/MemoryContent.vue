<script setup lang="ts">
import { computed, ref } from 'vue'

import { renderMarkdown, type CredentialLinks, type WikiLinkTargets } from '../markdown'

const props = withDefaults(
  defineProps<{
    content: string
    credentials?: CredentialLinks | null
    wikiLinks?: WikiLinkTargets | null
    width?: 'reading' | 'full'
  }>(),
  {
    credentials: null,
    wikiLinks: null,
    width: 'reading',
  },
)
const emit = defineEmits<{ open: [shortId: string]; credential: [slug: string] }>()

const rootRef = ref<HTMLElement | null>(null)

const html = computed(() =>
  renderMarkdown(props.content, {
    credentials: props.credentials ?? null,
    wikiLinks: props.wikiLinks ?? null,
  }),
)

function normalizeHeadingText(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function scrollToHeading(heading: string, index?: number) {
  const root = rootRef.value
  if (!root) return
  const headings = [...root.querySelectorAll<HTMLElement>('h2')]
  const normalized = normalizeHeadingText(heading)
  const byIndex = index !== undefined ? headings[index] : undefined
  const target =
    (byIndex && normalizeHeadingText(byIndex.textContent ?? '') === normalized ? byIndex : null) ??
    headings.find((el) => normalizeHeadingText(el.textContent ?? '') === normalized) ??
    byIndex
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

defineExpose({ scrollToHeading })

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const credential = target?.closest<HTMLAnchorElement>('a.kioku-cred')
  if (credential?.dataset.credential) {
    event.preventDefault()
    emit('credential', credential.dataset.credential)
    return
  }
  const wikilink = target?.closest<HTMLAnchorElement>('a.kioku-wikilink')
  if (wikilink?.dataset.shortId) {
    event.preventDefault()
    emit('open', wikilink.dataset.shortId)
  }
}
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- 已经过 DOMPurify 清洗，见 markdown.ts -->
  <div
    ref="rootRef"
    class="kioku-markdown"
    :class="`width-${width}`"
    @click="onClick"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.kioku-markdown {
  max-width: 58em;
  font-size: 15px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.kioku-markdown.width-full {
  max-width: none;
}
.kioku-markdown :deep(> :first-child) {
  margin-top: 0;
}
.kioku-markdown :deep(h1),
.kioku-markdown :deep(h2),
.kioku-markdown :deep(h3),
.kioku-markdown :deep(h4) {
  font-weight: 600;
  line-height: 1.5;
}
.kioku-markdown :deep(h1) {
  margin: 1.2em 0 10px;
  font-size: 22px;
  line-height: 1.45;
}
.kioku-markdown :deep(h2) {
  margin: 22px 0 7px;
  font-size: 16px;
  scroll-margin-top: 16px;
}
.kioku-markdown :deep(h3),
.kioku-markdown :deep(h4) {
  margin: 18px 0 6px;
  font-size: 15px;
}
.kioku-markdown :deep(p),
.kioku-markdown :deep(ul),
.kioku-markdown :deep(ol),
.kioku-markdown :deep(pre),
.kioku-markdown :deep(blockquote),
.kioku-markdown :deep(table),
.kioku-markdown :deep(details) {
  margin: 0 0 12px;
}
.kioku-markdown :deep(li) {
  position: relative;
  padding-left: 20px;
}
.kioku-markdown :deep(li > ul),
.kioku-markdown :deep(li > ol) {
  margin-bottom: 0;
}
.kioku-markdown :deep(ul > li)::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 0.93em;
  width: 10px;
  height: 1px;
  background: var(--ui-rule);
}
.kioku-markdown :deep(ol) {
  counter-reset: item;
}
.kioku-markdown :deep(ol[start]) {
  list-style: decimal;
  padding-left: 1.5em;
}
.kioku-markdown :deep(ol[start] > li) {
  padding-left: 0;
}
.kioku-markdown :deep(ol[start] > li)::before {
  content: none;
}
.kioku-markdown :deep(ol > li) {
  counter-increment: item;
}
.kioku-markdown :deep(ol > li)::before {
  content: counter(item);
  position: absolute;
  left: 0;
  top: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 2.13;
  color: var(--ui-text-muted);
}
.kioku-markdown :deep(strong),
.kioku-markdown :deep(b) {
  font-weight: 600;
}
.kioku-markdown :deep(em),
.kioku-markdown :deep(i) {
  font-style: normal;
  -webkit-text-emphasis: filled dot;
  text-emphasis: filled dot;
  -webkit-text-emphasis-position: under right;
  text-emphasis-position: under right;
}
.kioku-markdown :deep(code) {
  padding: 1px 5px;
  border: 1px solid var(--ui-border);
  font-family: var(--font-mono);
  font-size: 14px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
}
.kioku-markdown :deep(pre) {
  padding: 10px 14px;
  border: 1px solid var(--ui-border);
  overflow-x: auto;
  line-height: 1.7;
}
.kioku-markdown :deep(pre code) {
  padding: 0;
  border: 0;
}
.kioku-markdown :deep(blockquote) {
  padding-left: 12px;
  border-left: 2px solid var(--ui-border-accented);
  color: var(--ui-text-muted);
}
.kioku-markdown :deep(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  line-height: 1.6;
}
.kioku-markdown :deep(th),
.kioku-markdown :deep(td) {
  padding: 5px 12px 5px 0;
  border-bottom: 1px solid var(--ui-border);
  text-align: left;
}
.kioku-markdown :deep(th) {
  border-bottom-color: var(--ui-rule);
  font-weight: 600;
}
.kioku-markdown :deep(a[href]) {
  text-decoration: underline;
  text-decoration-color: var(--ui-text-muted);
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.kioku-markdown :deep(a[href]:hover) {
  text-decoration-color: currentColor;
}
.kioku-markdown :deep(hr) {
  margin: 18px 0;
  border-color: var(--ui-border);
}
.kioku-markdown :deep(details) {
  padding: 8px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.kioku-markdown :deep(summary) {
  position: relative;
  padding-left: 16px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
  list-style: none;
  cursor: pointer;
}
.kioku-markdown :deep(summary::-webkit-details-marker) {
  display: none;
}
.kioku-markdown :deep(summary)::before {
  content: '▸';
  position: absolute;
  left: 0;
  top: 0;
  color: var(--ui-text-muted);
}
.kioku-markdown :deep(details[open] > summary) {
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ui-border);
}
.kioku-markdown :deep(details[open] > summary)::before {
  content: '▾';
}
.kioku-markdown :deep(details > :last-child) {
  margin-bottom: 0;
}
.kioku-markdown :deep(a.kioku-wikilink) {
  color: inherit;
  text-decoration: underline solid var(--ui-rule);
  text-underline-offset: 3px;
  cursor: pointer;
}
.kioku-markdown :deep(a.kioku-wikilink:hover) {
  text-decoration-color: currentColor;
}
.kioku-markdown :deep(a.kioku-wikilink-missing) {
  color: var(--ui-text-muted);
  text-decoration-style: dotted;
}
.kioku-markdown :deep(.kioku-cred) {
  display: inline-block;
  margin: 0 2px;
  padding-right: 6px;
  border: 1px solid var(--ui-rule);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.55;
  color: inherit;
  text-decoration: none;
  overflow-wrap: anywhere;
}
.kioku-markdown :deep(a.kioku-cred[href]) {
  text-decoration: none;
  cursor: pointer;
}
.kioku-markdown :deep(a.kioku-cred[href]:hover) {
  background: var(--ui-bg-elevated);
}
.kioku-markdown :deep(.kioku-cred)::before {
  content: '凭据';
  margin-right: 6px;
  padding: 0 5px;
  background: var(--ui-bg-inverted);
  color: var(--ui-text-inverted);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 500;
}
.kioku-markdown :deep(.kioku-cred-missing) {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  text-decoration: line-through;
}
.kioku-markdown :deep(.kioku-cred-missing)::before {
  background: var(--ui-warning);
  color: var(--ui-bg);
}
</style>
