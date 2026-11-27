import { extractWikiLinks } from '@kioku/contracts'
import DOMPurify from 'dompurify'
import { Marked, Tokenizer, type Token, type Tokens } from 'marked'

import { splitPlaceholders } from './placeholders'

// 记忆正文是 Markdown，须经过转义与白名单清洗：
// - marked 仅放行不带属性的纯排版标签，图片退化为链接，任务勾选框画成字符
// - DOMPurify 禁止外链图片、表单控件、样式与 data/aria 属性，避免自托管服务发起外部请求或伪造界面
const PURIFY = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'code',
    'ul',
    'ol',
    'li',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'a',
    'strong',
    'em',
    'del',
    'b',
    'i',
    'u',
    's',
    'ins',
    'sub',
    'sup',
    'kbd',
    'small',
    'details',
    'summary',
  ],
  ALLOWED_ATTR: ['href', 'title', 'align', 'start'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const escapeText = (s: string) =>
  s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )

const PLAIN_TAG =
  /<\/?(?:br|hr|b|i|em|strong|u|s|del|ins|sub|sup|kbd|small|details|summary)\s*\/?>/gi

export function rawHtml(html: string): string {
  return html.replace(PLAIN_TAG, '').includes('<') ? escapeHtml(html) : html
}

const URL_START = /^(?:(?:https?|ftp):\/\/|www\.)/i
const WIDE_BLOCKS =
  /[\u{00a0}-\u{00ff}\u{2010}-\u{205e}\u{3000}-\u{303f}\u{fe10}-\u{fe1f}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff65}]/u
const FULLWIDTH_ASCII = /[\u{ff01}-\u{ff5e}]/u
const PUNCTUATION = /[\p{P}\p{S}\p{Zs}]/u
const endsUrl = (ch: string) =>
  FULLWIDTH_ASCII.test(ch) || (WIDE_BLOCKS.test(ch) && PUNCTUATION.test(ch))
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const SPACE = /\s/u

const inHostLabel = (previous: string) =>
  previous === '' ||
  previous === '.' ||
  previous === '-' ||
  previous === '@' ||
  CJK_LETTER.test(previous)

function urlEnd(src: string, from: number): number {
  let host = true
  let previous = ''
  for (let i = from; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i)!)
    if (ch === '<' || SPACE.test(ch)) return i
    if (endsUrl(ch)) return i
    if (ch === '/' || ch === '?' || ch === '#') host = false
    else if (host && CJK_LETTER.test(ch) && !inHostLabel(previous)) return i
    previous = ch
    i += ch.length
  }
  return src.length
}

function urlBeforeWideText(this: Tokenizer, src: string): Tokens.Link | undefined | false {
  const start = URL_START.exec(src)
  if (!start) return false
  return Tokenizer.prototype.url.call(this, src.slice(0, urlEnd(src, start[0].length)))
}

const imagesInLinks = new WeakSet<Token>()
function markImages(tokens: Token[]) {
  for (const token of tokens) {
    if (token.type === 'image') imagesInLinks.add(token)
    if ('tokens' in token && token.tokens) markImages(token.tokens)
  }
}

const marked = new Marked({
  gfm: true,
  tokenizer: { url: urlBeforeWideText },
  walkTokens(token) {
    if ((token.type === 'text' || token.type === 'code') && 'escaped' in token) {
      token.escaped = false
    }
    if (token.type === 'link') markImages(token.tokens ?? [])
  },
  renderer: {
    html({ text, block }: Tokens.HTML | Tokens.Tag) {
      const html = rawHtml(text)
      return block && html !== text ? `<p>${html}</p>` : html
    },
    image(token: Tokens.Image) {
      const alt = escapeText(this.parser.parseInline(token.tokens, this.parser.textRenderer))
      if (imagesInLinks.has(token)) return alt || escapeText(token.href)
      const title = token.title ? ` title="${escapeText(token.title)}"` : ''
      return `<a href="${escapeText(token.href)}"${title}>${alt || escapeText(token.href)}</a>`
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return checked ? '☑ ' : '☐ '
    },
  },
})

export function markdownToHtml(source: string): string {
  try {
    return marked.parse(source, { async: false })
  } catch {
    return `<pre>${escapeHtml(source)}</pre>`
  }
}

export interface CredentialLinks {
  bySlug: ReadonlyMap<string, { slug: string; label: string | null; available: boolean }>
  href: (slug: string) => string
}

export interface WikiLinkTargets {
  byShortId?: ReadonlyMap<string, { title: string }>
  href: (shortId: string) => string
}

export interface WikiLinkSegment {
  text: string
  link?: { shortId: string; alias: string | null }
}

export function splitWikiLinks(text: string): WikiLinkSegment[] {
  const matches = extractWikiLinks(text)
  if (!matches.length) return text ? [{ text }] : []
  const segments: WikiLinkSegment[] = []
  let cursor = 0
  for (const m of matches) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) })
    segments.push({ text: m.raw, link: { shortId: m.targetShortId, alias: m.alias } })
    cursor = m.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}

// 剥离标题与双链语境摘要中的常见行内 Markdown 符号，保留 [[m-xxxxxx|别名]] 与标识符内下划线
export function stripInlineMarkdown(text: string): string {
  const cleanPlain = (raw: string) =>
    raw
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+?)\*\*/g, '$1')
      .replace(/__([^_]+?)__/g, '$1')
      .replace(/~~([^~]+?)~~/g, '$1')
      .replace(/(^|[^\w])\*([^*]+?)\*(?=[^\w]|$)/g, '$1$2')
      .replace(/(^|[^\w])_([^_]+?)_(?=[^\w]|$)/g, '$1$2')
      .replace(/\*\*|~~/g, '')

  return splitWikiLinks(text)
    .map((seg) => (seg.link ? seg.text : cleanPlain(seg.text)))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function renderMarkdown(
  source: string,
  options: {
    credentials?: CredentialLinks | null
    wikiLinks?: WikiLinkTargets | null
  } = {},
): string {
  const fragment = DOMPurify.sanitize(markdownToHtml(source), {
    ...PURIFY,
    RETURN_DOM_FRAGMENT: true,
  })
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  if (options.credentials) markCredentials(fragment, options.credentials)
  if (options.wikiLinks) markWikiLinks(fragment, options.wikiLinks)
  const box = document.createElement('div')
  box.append(fragment)
  return box.innerHTML
}

function textNodes(root: DocumentFragment): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a, code, pre, summary, .kioku-cred, .kioku-wikilink')) {
      continue
    }
    texts.push(node as Text)
  }
  return texts
}

function markCredentials(root: DocumentFragment, { bySlug, href }: CredentialLinks) {
  for (const text of textNodes(root)) {
    const segments = splitPlaceholders(text.data)
    if (!segments.some((s) => s.ref)) continue
    const replacement = document.createDocumentFragment()
    for (const { text: part, ref } of segments) {
      if (!ref) {
        replacement.append(part)
        continue
      }
      const display = `${ref.slug}${ref.field ? `#${ref.field}` : ''}`
      const found = bySlug.get(ref.slug)
      if (!found || found.available) {
        const link = document.createElement('a')
        link.className = 'kioku-cred'
        link.href = href(ref.slug)
        link.dataset.credential = ref.slug
        link.title = found?.label ? `凭据：${found.label}` : `凭据：${display}`
        link.setAttribute('aria-label', `凭据 ${display}`)
        link.textContent = display
        replacement.append(link)
      } else {
        const badge = document.createElement('span')
        badge.className = 'kioku-cred kioku-cred-missing'
        badge.title = '凭据不存在或已删除'
        badge.textContent = display
        replacement.append(badge)
      }
    }
    text.replaceWith(replacement)
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg'

// 精简内联 lucide link-2 矢量图标，经由 DOM API 构建，避免拼接 HTML 字符串
function createWikiLinkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'kioku-wikilink-icon')

  for (const d of ['M9 17H7A5 5 0 0 1 7 7h2', 'M15 7h2a5 5 0 1 1 0 10h-2']) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }

  const line = document.createElementNS(SVG_NS, 'line')
  line.setAttribute('x1', '8')
  line.setAttribute('x2', '16')
  line.setAttribute('y1', '12')
  line.setAttribute('y2', '12')
  svg.append(line)

  return svg
}

function markWikiLinks(root: DocumentFragment, targets: WikiLinkTargets) {
  for (const text of textNodes(root)) {
    const segments = splitWikiLinks(text.data)
    if (!segments.some((s) => s.link)) continue
    const replacement = document.createDocumentFragment()
    for (const segment of segments) {
      if (!segment.link) {
        replacement.append(segment.text)
        continue
      }
      const { shortId, alias } = segment.link
      const resolved = targets.byShortId?.get(shortId)
      const link = document.createElement('a')
      link.className =
        targets.byShortId && !resolved ? 'kioku-wikilink kioku-wikilink-missing' : 'kioku-wikilink'
      link.href = targets.href(shortId)
      link.dataset.shortId = shortId
      link.title = resolved ? `${resolved.title}（${shortId}）` : shortId
      const label = document.createElement('span')
      label.className = 'kioku-wikilink-label'
      label.textContent = alias ?? resolved?.title ?? shortId
      link.append(createWikiLinkIcon(), label)
      replacement.append(link)
    }
    text.replaceWith(replacement)
  }
}
