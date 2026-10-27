<script setup lang="ts">
import { computed, ref } from 'vue'

import type { KeywordIndex } from '../keywords'
import { renderMarkdown, type CredentialLinks } from '../markdown'

const props = defineProps<{
  content: string
  keywords?: KeywordIndex | null
  self?: string
  credentials?: CredentialLinks | null
}>()
const emit = defineEmits<{ open: [uri: string]; credential: [id: string] }>()

const html = computed(() =>
  renderMarkdown(props.content, {
    keywords: props.keywords && props.self ? { index: props.keywords, self: props.self } : null,
    credentials: props.credentials ?? null,
  }),
)

// 点了关键词：只有一条记忆有它就直接打开，有好几条就列出来选
const choices = ref<{ keyword: string; uris: string[] } | null>(null)
function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  const credential = target?.closest<HTMLAnchorElement>('a.kioku-cred')
  if (credential?.dataset.credential) {
    event.preventDefault()
    emit('credential', credential.dataset.credential)
    return
  }
  const link = target?.closest<HTMLAnchorElement>('a.kioku-keyword')
  if (!link?.dataset.uris) return
  event.preventDefault()
  const uris = link.dataset.uris.split(' ').filter(Boolean)
  if (uris.length === 1) emit('open', uris[0]!)
  else choices.value = { keyword: link.textContent ?? '', uris }
}
function choose(uri: string) {
  choices.value = null
  emit('open', uri)
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 已经过 DOMPurify 清洗，见 markdown.ts -->
  <div class="kioku-markdown" @click="onClick" v-html="html" />
  <UModal
    :open="choices !== null"
    :title="`关键词「${choices?.keyword}」也在这些记忆里`"
    @update:open="(v) => !v && (choices = null)"
  >
    <template #body>
      <ul class="space-y-1">
        <li v-for="uri in choices?.uris ?? []" :key="uri">
          <UButton
            variant="link"
            color="neutral"
            class="font-mono"
            :label="uri"
            @click="choose(uri)"
          />
        </li>
      </ul>
    </template>
  </UModal>
</template>

<style scoped>
.kioku-markdown {
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.kioku-markdown :deep(h1),
.kioku-markdown :deep(h2),
.kioku-markdown :deep(h3),
.kioku-markdown :deep(h4) {
  font-weight: 600;
  margin: 1.25em 0 0.5em;
  line-height: 1.4;
}
.kioku-markdown :deep(h1) {
  font-size: 1.25rem;
}
.kioku-markdown :deep(h2) {
  font-size: 1.125rem;
}
.kioku-markdown :deep(h3),
.kioku-markdown :deep(h4) {
  font-size: 1rem;
}
.kioku-markdown :deep(> :first-child) {
  margin-top: 0;
}
.kioku-markdown :deep(p),
.kioku-markdown :deep(ul),
.kioku-markdown :deep(ol),
.kioku-markdown :deep(pre),
.kioku-markdown :deep(blockquote),
.kioku-markdown :deep(table) {
  margin: 0.6em 0;
}
.kioku-markdown :deep(ul) {
  list-style: disc;
  padding-left: 1.5em;
}
.kioku-markdown :deep(ol) {
  list-style: decimal;
  padding-left: 1.5em;
}
.kioku-markdown :deep(li) {
  margin: 0.2em 0;
}
.kioku-markdown :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.875em;
  background: var(--ui-bg-elevated);
  border-radius: 4px;
  padding: 0.1em 0.35em;
}
.kioku-markdown :deep(pre) {
  background: var(--ui-bg-elevated);
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
}
.kioku-markdown :deep(pre code) {
  background: none;
  padding: 0;
}
.kioku-markdown :deep(blockquote) {
  border-left: 3px solid var(--ui-border-accented);
  padding-left: 0.75em;
  color: var(--ui-text-muted);
}
.kioku-markdown :deep(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
}
.kioku-markdown :deep(th),
.kioku-markdown :deep(td) {
  border: 1px solid var(--ui-border);
  padding: 0.3em 0.6em;
}
.kioku-markdown :deep(th) {
  background: var(--ui-bg-elevated);
  font-weight: 600;
}
/* href 被清掉的链接（例如 javascript:）点了没有反应，不画成链接 */
.kioku-markdown :deep(a[href]) {
  color: var(--ui-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.kioku-markdown :deep(hr) {
  border-color: var(--ui-border);
  margin: 1.25em 0;
}
.kioku-markdown :deep(a.kioku-keyword) {
  color: inherit;
  text-decoration: underline dotted var(--ui-primary);
  text-underline-offset: 3px;
  cursor: pointer;
}
.kioku-markdown :deep(mark.kioku-own-keyword) {
  background: color-mix(in srgb, var(--ui-primary) 15%, transparent);
  color: inherit;
  border-radius: 3px;
  padding: 0 0.1em;
}
/* 凭据占位符的徽章：值不在这里，点了去凭据页 */
.kioku-markdown :deep(.kioku-cred) {
  display: inline-block;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.85em;
  line-height: 1.4;
  padding: 0 0.4em;
  border: 1px solid var(--ui-border-accented);
  border-radius: 9999px;
  background: var(--ui-bg-elevated);
  color: inherit;
  text-decoration: none;
}
/* 写在 a[href] 的规则后面、选择器更具体，盖过普通链接的颜色与下划线 */
.kioku-markdown :deep(a.kioku-cred[href]) {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
.kioku-markdown :deep(a.kioku-cred::before) {
  content: '🔑 ';
}
.kioku-markdown :deep(.kioku-cred-missing) {
  border-color: var(--ui-warning);
  color: var(--ui-warning);
  text-decoration: line-through;
}
</style>
