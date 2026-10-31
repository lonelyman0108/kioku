<script setup lang="ts">
import { computed, ref } from 'vue'

import type { KeywordIndex } from '../keywords'
import { renderMarkdown, type CredentialLinks } from '../markdown'

const props = defineProps<{
  content: string
  keywords?: KeywordIndex | null
  self?: string
  credentials?: CredentialLinks | null
  // 疑似明文的值：在正文里标出来
  plaintext?: readonly string[] | null
}>()
const emit = defineEmits<{ open: [uri: string]; credential: [id: string] }>()

const html = computed(() =>
  renderMarkdown(props.content, {
    keywords: props.keywords && props.self ? { index: props.keywords, self: props.self } : null,
    credentials: props.credentials ?? null,
    plaintext: props.plaintext ?? null,
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
    :title="`包含关键词「${choices?.keyword}」的记忆`"
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
  max-width: 39em;
  font-size: 15px;
  line-height: 1.85;
  overflow-wrap: anywhere;
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
/* 列表的记号：无序是一小段墨线，有序是等宽的序号 */
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
  background: var(--strata-rule);
}
.kioku-markdown :deep(ol) {
  counter-reset: item;
}
/* 从中间开始的有序列表（<ol start>）：计数器不知道起始的序号，交给浏览器画 */
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
/* 中文没有斜体，强调用着重号 */
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
  /* 折行时每一行的框都是完整的 */
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
  border-bottom-color: var(--strata-rule);
  font-weight: 600;
}
/* href 被清掉的链接（例如 javascript:）点了没有反应，不画成链接 */
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
/* 别的记忆的关键词：虚线，点了跳过去 */
.kioku-markdown :deep(a.kioku-keyword) {
  color: inherit;
  text-decoration: underline dotted var(--ui-text-muted);
  text-underline-offset: 3px;
  cursor: pointer;
}
.kioku-markdown :deep(a.kioku-keyword:hover) {
  text-decoration-color: currentColor;
}
/* 这条记忆自己的关键词：只标出来，一条赭色的线，不铺灰底 */
.kioku-markdown :deep(mark.kioku-own-keyword) {
  background: none;
  color: inherit;
  text-decoration: underline 2px var(--layer-owner);
  text-underline-offset: 3px;
}
/* 疑似明文的值：红色加下划线，红色是留给告警的 */
.kioku-markdown :deep(mark.kioku-plain) {
  background: none;
  color: var(--ui-error);
  border-bottom: 1px solid var(--ui-error);
}
/* 凭据占位符：一个黑底的「凭据」接着标识。值不在这里，点了去凭据页 */
.kioku-markdown :deep(.kioku-cred) {
  display: inline-block;
  margin: 0 2px;
  padding-right: 6px;
  border: 1px solid var(--strata-rule);
  font-family: var(--font-mono);
  font-size: 14px;
  line-height: 1.55;
  color: inherit;
  text-decoration: none;
  overflow-wrap: anywhere;
}
/* 写在 a[href] 的规则后面、选择器更具体，盖过普通链接的下划线 */
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
  background: var(--strata-solid);
  color: var(--strata-on-solid);
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
