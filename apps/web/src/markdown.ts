import DOMPurify from 'dompurify'
import { Marked, type Tokens } from 'marked'

import { splitByKeywords, type KeywordIndex } from './keywords'

// 记忆正文是 Markdown，可能来自 agent、导入或别的成员，里面的 HTML 不能信任：
// 渲染出来的 HTML 一律经过 DOMPurify。下面这些也一并去掉：
// - 图片：页面的 CSP 只允许站内图片，外部图片会被拦下并报违规，自托管服务也不该替记忆去请求外部地址；
//   Markdown 里的图片渲染成指向它的链接
// - 表单控件、样式与 class、id、data 属性：正文不能伪装成界面上的按钮或提示，也不能冒充下面加的关键词链接
const PURIFY = {
  FORBID_TAGS: [
    'img',
    'picture',
    'video',
    'audio',
    'source',
    'style',
    'form',
    'button',
    'select',
    'textarea',
  ],
  FORBID_ATTR: ['style', 'class', 'id'],
  ALLOW_DATA_ATTR: false,
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// 正文里直接写的 HTML 只放行不带属性的几个排版标签，其余原样显示成文字。
// 带属性的标签交给 DOMPurify 也会被清掉，但浏览器只要解析到 onerror 这类事件属性，
// 哪怕是在不执行脚本的文档里，也会报一条 CSP 违规：存着这种内容的记忆每打开一次就报一次
const PLAIN_TAG =
  /<\/?(?:br|hr|b|i|em|strong|u|s|del|ins|sub|sup|kbd|small|details|summary)\s*\/?>/gi

export function rawHtml(html: string): string {
  return html.replace(PLAIN_TAG, '').includes('<') ? escapeHtml(html) : html
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text, block }: Tokens.HTML | Tokens.Tag) {
      const html = rawHtml(text)
      return block && html !== text ? `<p>${html}</p>` : html
    },
    image({ href, text }: Tokens.Image) {
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`
    },
  },
})

export interface KeywordLinks {
  index: KeywordIndex
  // 当前这条记忆：自己的关键词只标出来，不链接回自己
  self: string
}

export function renderMarkdown(source: string, keywords?: KeywordLinks | null): string {
  const html = marked.parse(source, { async: false })
  const fragment = DOMPurify.sanitize(html, { ...PURIFY, RETURN_DOM_FRAGMENT: true })
  // 正文里的链接都在新窗口打开，不带来源页
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  if (keywords) markKeywords(fragment, keywords)
  const box = document.createElement('div')
  box.append(fragment)
  return box.innerHTML
}

// 在清洗过的正文里标出关键词：别的记忆的关键词变成链接（data-uris 里是那些记忆，空格分隔），
// 自己的关键词只加底色。链接、行内代码与代码块里的文字不动
function markKeywords(root: DocumentFragment, { index, self }: KeywordLinks) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a, code, pre')) continue
    texts.push(node as Text)
  }
  for (const text of texts) {
    const segments = splitByKeywords(text.data, index)
    if (!segments.some((s) => s.keyword)) continue
    const replacement = document.createDocumentFragment()
    for (const segment of segments) {
      if (!segment.keyword) {
        replacement.append(segment.text)
        continue
      }
      const others = (index.targets.get(segment.keyword) ?? []).filter((uri) => uri !== self)
      if (!others.length) {
        const mark = document.createElement('mark')
        mark.className = 'kioku-own-keyword'
        mark.textContent = segment.text
        replacement.append(mark)
        continue
      }
      const link = document.createElement('a')
      link.className = 'kioku-keyword'
      link.href = '#'
      link.dataset.uris = others.join(' ')
      link.title = others.join('\n')
      link.textContent = segment.text
      replacement.append(link)
    }
    text.replaceWith(replacement)
  }
}
