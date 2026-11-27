import { extractWikiLinks, WIKI_LINK_REGEX } from '@kioku/contracts'
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

interface InlineToken {
  text: string
  link?: { shortId: string; alias: string | null }
}

const ASCII_WORD_OR_SLASH = /[A-Za-z0-9_/]/
const BARE_URL_PREFIX_STICKY = /(?:(?:https?|ftp):\/\/|www\.)/iy
const DANGLING_OPEN = /(^|[\s（(「『【[，。；：、,:;])(?:\*\*|~~)(?=[^\s*~/])/g
const DANGLING_CLOSE = /(?<=[^\s*~/])(?:\*\*|~~)(?=$|[\s）)」』】\]，。；：、.,:;!?！？])/g

function bareUrlEnd(src: string, from: number): number {
  let host = true
  let previous = ''
  for (let i = from; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i)!)
    if (ch === '\x00' || ch === '\x01' || ch === '<' || SPACE.test(ch)) return i
    if (endsUrl(ch)) return i
    if (ch === '/' || ch === '?' || ch === '#') host = false
    else if (host && CJK_LETTER.test(ch) && !inHostLabel(previous)) return i
    previous = ch
    i += ch.length
  }
  return src.length
}

// 线性保护行内代码、双链与控制字符占位，避免后续链接/强调清理误改代码内容或把代码内双链激活
function protectCodeAndWikiLinks(text: string, tokens: InlineToken[]): string {
  const tickRuns = new Map<number, number[]>()
  const n = text.length
  for (let i = 0; i < n;) {
    if (text[i] !== '`') {
      i++
      continue
    }
    const start = i
    while (i < n && text[i] === '`') i++
    const len = i - start
    let list = tickRuns.get(len)
    if (!list) {
      list = []
      tickRuns.set(len, list)
    }
    list.push(start)
  }

  const tickCursors = new Map<number, number>()
  const wikiSticky = new RegExp(WIKI_LINK_REGEX.source, 'iy')
  const out: string[] = []
  let plainStart = 0

  const flushPlain = (end: number) => {
    if (end > plainStart) out.push(text.slice(plainStart, end))
  }

  const emitToken = (token: InlineToken) => {
    const id = tokens.length
    tokens.push(token)
    out.push(`\x00${id}\x01`)
  }

  for (let i = 0; i < n;) {
    const ch = text[i]!
    if (ch === '\x00' || ch === '\x01') {
      flushPlain(i)
      emitToken({ text: ch })
      i++
      plainStart = i
      continue
    }

    if (ch === '`') {
      const start = i
      while (i < n && text[i] === '`') i++
      const len = i - start
      const list = tickRuns.get(len)
      if (list) {
        let cursor = tickCursors.get(len) ?? 0
        while (cursor < list.length && list[cursor]! <= start) cursor++
        tickCursors.set(len, cursor)
        if (cursor < list.length) {
          const closeStart = list[cursor]!
          tickCursors.set(len, cursor + 1)
          let inner = text.slice(i, closeStart)
          if (
            inner.length >= 2 &&
            inner.startsWith(' ') &&
            inner.endsWith(' ') &&
            /[^ ]/.test(inner)
          ) {
            inner = inner.slice(1, -1)
          }
          flushPlain(start)
          emitToken({ text: inner })
          i = closeStart + len
          plainStart = i
          continue
        }
      }
      continue
    }

    if (ch === '[' && text[i + 1] === '[') {
      wikiSticky.lastIndex = i
      const match = wikiSticky.exec(text)
      if (match) {
        flushPlain(i)
        const shortId = match[1]!.toLowerCase()
        const alias = match[2] !== undefined ? match[2].trim() || null : null
        emitToken({ text: match[0], link: { shortId, alias } })
        i += match[0].length
        plainStart = i
        continue
      }
    }

    i++
  }

  flushPlain(n)
  return out.join('')
}

// 线性展开 Markdown 图片与行内链接，支持链接地址内成对括号（如 Wikipedia 词条）
function unwrapMarkdownLinks(src: string): string {
  const n = src.length
  const closeParen = new Int32Array(n).fill(-1)
  const parenStack: number[] = []
  for (let i = 0; i < n; i++) {
    const ch = src[i]!
    if (ch === '\\' && i + 1 < n) {
      i++
      continue
    }
    if (ch === '\n' || ch === '\r') {
      parenStack.length = 0
      continue
    }
    if (ch === '(') {
      parenStack.push(i)
    } else if (ch === ')' && parenStack.length > 0) {
      closeParen[parenStack.pop()!] = i
    }
  }

  const out: string[] = []
  const stack: Array<{ outIdx: number; isImage: boolean; baseCount: number }> = []
  let nonEmptyCount = 0

  for (let i = 0; i < n;) {
    if (src[i] === '!' && src[i + 1] === '[') {
      stack.push({ outIdx: out.length, isImage: true, baseCount: nonEmptyCount })
      out.push('![')
      nonEmptyCount++
      i += 2
      continue
    }
    if (src[i] === '[') {
      stack.push({ outIdx: out.length, isImage: false, baseCount: nonEmptyCount })
      out.push('[')
      nonEmptyCount++
      i += 1
      continue
    }
    if (src[i] === ']' && stack.length > 0) {
      const top = stack[stack.length - 1]!
      if (src[i + 1] === '(') {
        const closeIdx = closeParen[i + 1]!
        if (closeIdx !== -1 && (top.isImage || nonEmptyCount > top.baseCount + 1)) {
          stack.pop()
          out[top.outIdx] = ''
          nonEmptyCount--
          i = closeIdx + 1
          continue
        }
      }
      stack.pop()
      out.push(']')
      nonEmptyCount++
      i += 1
      continue
    }
    out.push(src[i]!)
    nonEmptyCount++
    i += 1
  }

  return out.join('')
}

// 线性保护裸网址，避免路径中的 _foo_ 或 ** 被强调规则改写
function protectBareUrls(src: string, tokens: InlineToken[]): string {
  const n = src.length
  const out: string[] = []
  let plainStart = 0

  for (let i = 0; i < n;) {
    const ch = src[i]!
    if (ch === 'h' || ch === 'H' || ch === 'f' || ch === 'F' || ch === 'w' || ch === 'W') {
      const isWww = ch === 'w' || ch === 'W'
      if (!isWww || i === 0 || !ASCII_WORD_OR_SLASH.test(src[i - 1]!)) {
        BARE_URL_PREFIX_STICKY.lastIndex = i
        const match = BARE_URL_PREFIX_STICKY.exec(src)
        if (match) {
          const urlStart = i + match[0].length
          let end = bareUrlEnd(src, urlStart)
          // 剥离紧贴裸网址末尾的强调/删除线闭合符号，避免吞掉 **url**、_url_、~~url~~ 的右边界
          while (
            end > urlStart &&
            (src[end - 1] === '*' || src[end - 1] === '_' || src[end - 1] === '~')
          ) {
            end--
          }
          if (end > urlStart) {
            if (i > plainStart) out.push(src.slice(plainStart, i))
            const id = tokens.length
            tokens.push({ text: src.slice(i, end) })
            out.push(`\x00${id}\x01`)
            i = end
            plainStart = i
            continue
          }
        }
      }
    }
    i++
  }

  if (plainStart === 0) return src
  if (plainStart < n) out.push(src.slice(plainStart))
  return out.join('')
}

// 线性配对剥离强调/粗体/删除线边界，避开单词内下划线、乘号、路径通配符与空格内侧
function stripPairedDelimiter(
  input: string,
  delim: string,
  checkOpenWordBoundary: boolean,
  checkCloseWordBoundary = checkOpenWordBoundary,
): string {
  const d = delim.length
  const ch = delim[0]!
  if (!input.includes(delim)) return input

  const n = input.length
  const openStack: number[] = []
  const removed = new Uint8Array(n)
  let hasRemoved = false

  for (let i = 0; i <= n - d;) {
    if (input[i] !== ch) {
      i++
      continue
    }
    const runStart = i
    while (i < n && input[i] === ch) i++
    const runLen = i - runStart
    if (runLen < d) continue

    const leftOfRun = runStart > 0 ? input[runStart - 1]! : ''
    const rightOfRun = i < n ? input[i]! : ''

    const canClose =
      openStack.length > 0 &&
      leftOfRun !== '' &&
      !/\s/.test(leftOfRun) &&
      leftOfRun !== '/' &&
      rightOfRun !== '/' &&
      (!checkCloseWordBoundary || !ASCII_WORD_OR_SLASH.test(rightOfRun))

    if (canClose) {
      const openPos = openStack.pop()!
      const closePos = i - d
      for (let k = 0; k < d; k++) {
        removed[openPos + k] = 1
        removed[closePos + k] = 1
      }
      hasRemoved = true
      continue
    }

    const canOpen =
      rightOfRun !== '' &&
      !/\s/.test(rightOfRun) &&
      rightOfRun !== '/' &&
      leftOfRun !== '/' &&
      (!checkOpenWordBoundary || !ASCII_WORD_OR_SLASH.test(leftOfRun))

    if (canOpen) {
      openStack.push(i - d)
    }
  }

  if (!hasRemoved) return input
  const out: string[] = []
  let keepStart = 0
  for (let i = 0; i < n; i++) {
    if (removed[i]) {
      if (i > keepStart) out.push(input.slice(keepStart, i))
      keepStart = i + 1
    }
  }
  if (keepStart < n) out.push(input.slice(keepStart))
  return out.join('')
}

// 剥离标题与双链语境摘要中的常见行内 Markdown 符号，输出可供纯文本或 WikiText 消费的切分结果
export function stripInlineMarkdownSegments(text: string): WikiLinkSegment[] {
  if (!text) return []
  const tokens: InlineToken[] = []
  let s = protectCodeAndWikiLinks(text, tokens)
  s = unwrapMarkdownLinks(s)
  s = protectBareUrls(s, tokens)
  s = stripPairedDelimiter(s, '***', true, false)
  s = stripPairedDelimiter(s, '___', true, true)
  s = stripPairedDelimiter(s, '**', true, false)
  s = stripPairedDelimiter(s, '__', true, true)
  s = stripPairedDelimiter(s, '~~', false, false)
  s = stripPairedDelimiter(s, '*', true, true)
  s = stripPairedDelimiter(s, '_', true, true)
  s = s.replace(DANGLING_OPEN, '$1').replace(DANGLING_CLOSE, '')

  const segments: WikiLinkSegment[] = []
  let plainBuf = ''
  const flushPlain = () => {
    if (!plainBuf) return
    const normalized = plainBuf.replace(/\s+/g, ' ')
    plainBuf = ''
    if (normalized) segments.push({ text: normalized })
  }

  let cursor = 0
  while (cursor < s.length) {
    const start = s.indexOf('\x00', cursor)
    if (start === -1) {
      plainBuf += s.slice(cursor)
      break
    }
    const end = s.indexOf('\x01', start + 1)
    if (end === -1) {
      plainBuf += s.slice(cursor)
      break
    }
    if (start > cursor) plainBuf += s.slice(cursor, start)
    const token = tokens[Number(s.slice(start + 1, end))]
    if (token?.link) {
      flushPlain()
      segments.push({ text: token.text, link: token.link })
    } else if (token) {
      plainBuf += token.text
    }
    cursor = end + 1
  }
  flushPlain()

  if (segments.length > 0 && !segments[0]!.link) {
    segments[0]!.text = segments[0]!.text.trimStart()
    if (!segments[0]!.text) segments.shift()
  }
  if (segments.length > 0 && !segments[segments.length - 1]!.link) {
    const last = segments[segments.length - 1]!
    last.text = last.text.trimEnd()
    if (!last.text) segments.pop()
  }

  return segments
}

export function stripInlineMarkdown(text: string): string {
  return stripInlineMarkdownSegments(text)
    .map((seg) => seg.text)
    .join('')
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
