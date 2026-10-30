import DOMPurify from 'dompurify'
import { Marked, Tokenizer, type Token, type Tokens } from 'marked'

import { splitByKeywords, type KeywordIndex } from './keywords'
import { splitPlaceholders } from './placeholders'

// 记忆正文是 Markdown，可能来自 agent、导入或别的成员，不能信任。分两道：
// - marked：正文里的文字一律转义，直接写的 HTML 只放行不带属性的几个排版标签（见 rawHtml）；
//   图片渲染成指向它的链接，任务列表的勾选框画成字符，都不生成元素
// - DOMPurify 按白名单清洗，只留 Markdown 会生成的标签与 href、title、align、start 属性。
//   不要图片：页面的 CSP 只允许站内图片，外部图片会被拦下并报违规，自托管服务也不该替记忆去请求外部地址；
//   不要表单控件、对话框、样式、class、id 与 data 属性：正文不能伪装成界面上的输入框、按钮或提示，
//   也不能冒充下面加的关键词链接
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

// 与 marked 转义文字的方式一致：已经是字符引用的 &（例如 &copy;）留着，由浏览器显示成字符
const escapeText = (s: string) =>
  s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )

// 正文里直接写的 HTML 只放行不带属性的几个排版标签，其余原样显示成文字。
// 带属性的标签交给 DOMPurify 也会被清掉，但浏览器只要解析到 onerror 这类事件属性，
// 哪怕是在不执行脚本的文档里，也会报一条 CSP 违规：存着这种内容的记忆每打开一次就报一次
const PLAIN_TAG =
  /<\/?(?:br|hr|b|i|em|strong|u|s|del|ins|sub|sup|kbd|small|details|summary)\s*\/?>/gi

export function rawHtml(html: string): string {
  return html.replace(PLAIN_TAG, '').includes('<') ? escapeHtml(html) : html
}

// GFM 自动识别的网址一直延伸到空白或 <，正文里紧跟在网址后面的全角标点与中文会被一起链进去
// （例如「https://files.example.com，账号」）。识别之前先找出网址在哪里结束（urlEnd），只把这一段交给
// marked 原来的规则，末尾的英文标点与不成对的括号照原来的规则去掉。显式写的链接（[文字](网址) 与 <网址>）不经过这里
const URL_START = /^(?:(?:https?|ftp):\/\/|www\.)/i
// 全角与中文常用的标点：通用标点、CJK 标点、竖排与小写变体、全角与半角形式这几块里的标点、符号与空格。
// 这几块里的字母不算（々、〆、〇 等），日文与中文的网址路径里会有它们
const WIDE_BLOCKS =
  /[\u{2010}-\u{205e}\u{3000}-\u{303f}\u{fe10}-\u{fe1f}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff65}]/u
const PUNCTUATION = /[\p{P}\p{S}\p{Zs}]/u
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const SPACE = /\s/u

// 域名里的中日韩文字要接在域名开头、点、连字符、@ 或别的中日韩文字后面（example.中国）。
// 紧贴在英文字母、数字或括号后面的（example.com账号）是域名之后的正文
const inHostLabel = (previous: string) =>
  previous === '' ||
  previous === '.' ||
  previous === '-' ||
  previous === '@' ||
  CJK_LETTER.test(previous)

// 网址在 src 里到哪里为止（不含），from 是协议之后、域名开始的位置。
// 遇到全角或中文的标点就结束，在域名里、路径里都是（网址里不会有）；中日韩文字只在还没到路径
// （第一个 / ? # 之前）、又不是域名的一部分时结束，路径与查询里的中文留着（https://ja.wikipedia.org/wiki/東京）。
// 第一个空白或 < 本来就是网址的尽头，扫到那里为止：每个网址只扫它自己这一段，不扫后面的整段正文
function urlEnd(src: string, from: number): number {
  let host = true
  let previous = ''
  for (let i = from; i < src.length;) {
    const ch = String.fromCodePoint(src.codePointAt(i)!)
    if (ch === '<' || SPACE.test(ch)) return i
    if (WIDE_BLOCKS.test(ch) && PUNCTUATION.test(ch)) return i
    if (ch === '/' || ch === '?' || ch === '#') host = false
    else if (host && CJK_LETTER.test(ch) && !inHostLabel(previous)) return i
    previous = ch
    i += ch.length
  }
  return src.length
}

// 只处理以协议或 www. 开头的网址；邮箱、mailto: 这些交给原来的规则（返回 false）
function urlBeforeWideText(this: Tokenizer, src: string): Tokens.Link | undefined | false {
  const start = URL_START.exec(src)
  if (!start) return false
  return Tokenizer.prototype.url.call(this, src.slice(0, urlEnd(src, start[0].length)))
}

// 链接里面的图片（例如带链接的徽章）：只留替代文字，没有替代文字时写图片的地址，免得链接里再套一个链接
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
    // 行内出现 <code>、<pre>、<kbd>、<script> 之后，marked 会把后面的文字标成「已经转义」原样输出，
    // 直到对应的结束标签，没有结束标签就一直到正文末尾。这里一律交给渲染器转义，代码块也一样
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
      // 替代文字只取纯文本，与 marked 自己渲染图片时一样
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

// 只做 Markdown 这一步，还没有清洗；渲染出错时（例如嵌套太深）退回原文
export function markdownToHtml(source: string): string {
  try {
    return marked.parse(source, { async: false })
  } catch {
    return `<pre>${escapeHtml(source)}</pre>`
  }
}

export interface KeywordLinks {
  index: KeywordIndex
  // 当前这条记忆：自己的关键词只标出来，不链接回自己
  self: string
}

// 正文引用的凭据怎么显示：只有读者自己私人层的记忆才解析，按标识找读者自己的有效凭据
export interface CredentialLinks {
  byIdentifier: ReadonlyMap<string, { id: string; name: string; fields: readonly string[] }>
  // 凭据详情的地址
  href: (id: string) => string
}

export function renderMarkdown(
  source: string,
  options: { keywords?: KeywordLinks | null; credentials?: CredentialLinks | null } = {},
): string {
  const fragment = DOMPurify.sanitize(markdownToHtml(source), {
    ...PURIFY,
    RETURN_DOM_FRAGMENT: true,
  })
  // 正文里的链接都在新窗口打开，不带来源页
  for (const link of fragment.querySelectorAll('a[href]')) {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  }
  // 先画凭据的徽章，再标关键词：关键词可能出现在占位符里，先标关键词会把占位符拆开
  if (options.credentials) markCredentials(fragment, options.credentials)
  if (options.keywords) markKeywords(fragment, options.keywords)
  const box = document.createElement('div')
  box.append(fragment)
  return box.innerHTML
}

// 文字节点，跳过链接、代码与折叠块的标题，以及已经画好的凭据徽章
function textNodes(root: DocumentFragment): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('a, code, pre, summary, .kioku-cred')) continue
    texts.push(node as Text)
  }
  return texts
}

// 把占位符画成徽章：解析得到的是链接（data-credential 是凭据 id，点了去凭据页），
// 解析不到或没有这个字段的标出来。代码里的占位符照原样显示
function markCredentials(root: DocumentFragment, { byIdentifier, href }: CredentialLinks) {
  for (const text of textNodes(root)) {
    const segments = splitPlaceholders(text.data)
    if (!segments.some((s) => s.ref)) continue
    const replacement = document.createDocumentFragment()
    for (const { text: part, ref } of segments) {
      if (!ref) {
        replacement.append(part)
        continue
      }
      const label = `${ref.identifier}${ref.field ? `#${ref.field}` : ''}`
      const credential = byIdentifier.get(ref.identifier)
      const missingField =
        credential && ref.field !== null && !credential.fields.includes(ref.field)
      if (credential && !missingField) {
        const link = document.createElement('a')
        link.className = 'kioku-cred'
        link.href = href(credential.id)
        link.dataset.credential = credential.id
        link.title = `凭据：${credential.name}`
        link.setAttribute('aria-label', `凭据 ${label}`)
        link.textContent = label
        replacement.append(link)
        continue
      }
      const badge = document.createElement('span')
      badge.className = 'kioku-cred kioku-cred-missing'
      badge.title = credential
        ? `凭据 ${credential.name} 没有字段 ${ref.field}`
        : '没有这条凭据，或者它已经删除'
      badge.textContent = label
      replacement.append(badge)
    }
    text.replaceWith(replacement)
  }
}

// 在清洗过的正文里标出关键词：别的记忆的关键词变成链接（data-uris 里是那些记忆，空格分隔），
// 自己的关键词只加底色。链接、代码与折叠块的标题里的文字不动：标题里放了链接，点它就展不开了
function markKeywords(root: DocumentFragment, { index, self }: KeywordLinks) {
  for (const text of textNodes(root)) {
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
