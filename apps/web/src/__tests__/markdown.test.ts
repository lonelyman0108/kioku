import DOMPurify from 'dompurify'
import { Tokenizer } from 'marked'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markdownToHtml,
  rawHtml,
  renderMarkdown,
  splitWikiLinks,
  stripInlineMarkdown,
  stripInlineMarkdownSegments,
} from '../markdown'

describe('rawHtml', () => {
  it('不带属性的排版标签照常渲染', () => {
    expect(rawHtml('<br>')).toBe('<br>')
    expect(rawHtml('<br/>')).toBe('<br/>')
    expect(rawHtml('<details>\n<summary>展开</summary>\n内容\n</details>\n')).toBe(
      '<details>\n<summary>展开</summary>\n内容\n</details>\n',
    )
  })

  it('带属性或不在名单里的标签原样显示成文字', () => {
    expect(rawHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    )
    expect(rawHtml('<b style="color:red">')).toBe('&lt;b style=&quot;color:red&quot;&gt;')
    expect(rawHtml('<script>')).toBe('&lt;script&gt;')
    expect(rawHtml('<!-- 注释 -->')).toBe('&lt;!-- 注释 --&gt;')
  })

  it('整段里只要有一个不放行的标签，整段都显示成文字', () => {
    expect(rawHtml('<details>\n<a href="https://example.com">x</a>\n</details>')).toBe(
      '&lt;details&gt;\n&lt;a href=&quot;https://example.com&quot;&gt;x&lt;/a&gt;\n&lt;/details&gt;',
    )
  })

  it('没有闭合的标签不会和后面的内容拼成属性', () => {
    expect(rawHtml('<details><img src=x onerror=alert(1)')).toBe(
      '&lt;details&gt;&lt;img src=x onerror=alert(1)',
    )
  })
})

describe('markdownToHtml', () => {
  it('行内的 <code> 之后，正文里的文字照样转义，拼不出输入框和对话框', () => {
    const html = markdownToHtml(
      '<code>x\n\n<input type="password"placeholder="输入主密码">\n\n<dialog/open>会话已过期',
    )
    expect(html).not.toMatch(/<input|<dialog/)
    expect(html).toContain('&lt;input type=&quot;password&quot;placeholder=')
    expect(html).toContain('&lt;dialog/open&gt;')
  })

  it('任务列表的勾选框画成字符，不生成输入框', () => {
    const html = markdownToHtml('- [ ] 待办\n- [x] 完成')
    expect(html).not.toContain('<input')
    expect(html).toContain('☐ 待办')
    expect(html).toContain('☑ 完成')
  })

  it('图片渲染成链接；在链接里面时只留替代文字，不套两层链接', () => {
    expect(
      markdownToHtml('[![build](https://example.com/badge.svg)](https://example.com/ci)'),
    ).toBe('<p><a href="https://example.com/ci">build</a></p>\n')
    // 没有替代文字时写图片的地址，不留一个看不见的空链接
    expect(markdownToHtml('[![](https://example.com/badge.svg)](https://example.com/ci)')).toBe(
      '<p><a href="https://example.com/ci">https://example.com/badge.svg</a></p>\n',
    )
    expect(markdownToHtml('![**粗** 图](https://example.com/x.png "说明")')).toBe(
      '<p><a href="https://example.com/x.png" title="说明">粗 图</a></p>\n',
    )
  })

  it('替代文字里的字符引用不重复转义', () => {
    const html = markdownToHtml('![&copy; 2024](https://example.com/x.png)')
    expect(html).toContain('>&copy; 2024</a>')
    expect(html).not.toContain('&amp;copy;')
  })

  describe('自动识别的网址', () => {
    const link = (href: string, text = href) => `<a href="${href}">${text}</a>`
    const paragraph = (html: string) => `<p>${html}</p>\n`

    // 路径里有中文的网址：链接的地址按 marked 的规则编码，显示的文字照原样
    const wide = (url: string) => link(encodeURI(url), url)

    it('遇到全角或中文的标点就结束，在域名之后、路径里都是', () => {
      expect(markdownToHtml('https://files.example.com，账号 admin')).toBe(
        paragraph(`${link('https://files.example.com')}，账号 admin`),
      )
      for (const mark of '，。；：！？、）」』】”…') {
        expect(markdownToHtml(`见 https://files.example.com/a${mark}然后`)).toBe(
          paragraph(`见 ${link('https://files.example.com/a')}${mark}然后`),
        )
      }
      // 标点不会是域名的一部分：后面的正文里有 / 也在标点处结束
      expect(markdownToHtml('https://files.example.com，账号/密码 见下')).toBe(
        paragraph(`${link('https://files.example.com')}，账号/密码 见下`),
      )
      // 拉丁补充里的中间点、全角的字母与数字也结束网址；拉丁字母（é）留在路径里
      expect(markdownToHtml('https://example.com·说明')).toBe(
        paragraph(`${link('https://example.com')}·说明`),
      )
      expect(markdownToHtml('https://example.com/a·b')).toBe(
        paragraph(`${link('https://example.com/a')}·b`),
      )
      expect(markdownToHtml('https://example.com１２３号')).toBe(
        paragraph(`${link('https://example.com')}１２３号`),
      )
      expect(markdownToHtml('https://example.com/fileＡＢ')).toBe(
        paragraph(`${link('https://example.com/file')}ＡＢ`),
      )
      expect(markdownToHtml('https://example.com/café')).toBe(
        paragraph(wide('https://example.com/café')),
      )
      expect(markdownToHtml('https://example.com/search?q=kioku&lang=zh，然后')).toBe(
        paragraph(`${link('https://example.com/search?q=kioku&amp;lang=zh')}，然后`),
      )
      expect(markdownToHtml('（https://example.com）')).toBe(
        paragraph(`（${link('https://example.com')}）`),
      )
      expect(markdownToHtml('www.example.com，账号')).toBe(
        paragraph(`${link('http://www.example.com', 'www.example.com')}，账号`),
      )
    })

    it('中日韩文字只在紧跟着域名、还没到路径时结束；域名里用点隔开的与路径、查询里的留着', () => {
      expect(markdownToHtml('网盘https://files.example.com账号')).toBe(
        paragraph(`网盘${link('https://files.example.com')}账号`),
      )
      expect(markdownToHtml('https://example.com:8080账号/密码')).toBe(
        paragraph(`${link('https://example.com:8080')}账号/密码`),
      )
      expect(markdownToHtml('https://example.中国/path 见下')).toBe(
        paragraph(`${wide('https://example.中国/path')} 见下`),
      )
      expect(markdownToHtml('https://example.中国，然后')).toBe(
        paragraph(`${wide('https://example.中国')}，然后`),
      )
      expect(markdownToHtml('https://ja.wikipedia.org/wiki/東京')).toBe(
        paragraph(wide('https://ja.wikipedia.org/wiki/東京')),
      )
      // 々 是字母不是标点，留在路径里
      expect(markdownToHtml('https://ja.wikipedia.org/wiki/佐々木，然后')).toBe(
        paragraph(`${wide('https://ja.wikipedia.org/wiki/佐々木')}，然后`),
      )
      expect(markdownToHtml('https://example.com/ページ?q=東京#見出し')).toBe(
        paragraph(wide('https://example.com/ページ?q=東京#見出し')),
      )
    })

    it('很多网址挤在一大段没有空白的中文里时，每个网址只扫它自己这一段', () => {
      const url = vi.spyOn(Tokenizer.prototype, 'url')
      try {
        const source = '见https://example.com/a，然后'.repeat(4000)
        const started = performance.now()
        const html = markdownToHtml(source)
        const elapsed = performance.now() - started
        expect(html.match(/<a /g)).toHaveLength(4000)
        // 交给 marked 原来规则的只有截好的网址，加起来不到正文的长度；每次都扫到段尾的话是正文长度的上千倍
        const scanned = url.mock.calls.reduce((sum, [src]) => sum + src.length, 0)
        expect(scanned).toBeLessThan(source.length)
        // 自己找结尾的那一步也不能每次扫到段尾：线性时几十毫秒，那样要好几秒
        expect(elapsed).toBeLessThan(1500)
      } finally {
        url.mockRestore()
      }
    })

    it('显式写的链接照原样，网址里的中文也在', () => {
      const encoded = 'https://files.example.com%EF%BC%8C%E8%B4%A6%E5%8F%B7'
      expect(markdownToHtml('[网盘](https://files.example.com，账号)')).toBe(
        paragraph(link(encoded, '网盘')),
      )
      expect(markdownToHtml('<https://files.example.com，账号>')).toBe(
        paragraph(link(encoded, 'https://files.example.com，账号')),
      )
    })

    it('英文网址、带括号的网址与邮箱照常', () => {
      expect(markdownToHtml('see https://example.com/path?q=1.')).toBe(
        paragraph(`see ${link('https://example.com/path?q=1')}.`),
      )
      expect(
        markdownToHtml('https://en.wikipedia.org/wiki/Foo_(bar) and (https://example.com)'),
      ).toBe(
        paragraph(
          `${link('https://en.wikipedia.org/wiki/Foo_(bar)')} and (${link('https://example.com')})`,
        ),
      )
      expect(markdownToHtml('https://en.wikipedia.org/wiki/Foo_(bar)，然后')).toBe(
        paragraph(`${link('https://en.wikipedia.org/wiki/Foo_(bar)')}，然后`),
      )
      expect(markdownToHtml('(https://example.com)中文')).toBe(
        paragraph(`(${link('https://example.com')})中文`),
      )
      expect(markdownToHtml('联系 foo@example.com，谢谢')).toBe(
        paragraph(`联系 ${link('mailto:foo@example.com', 'foo@example.com')}，谢谢`),
      )
    })
  })

  it('嵌套太深、marked 渲染出错时退回转义后的原文', () => {
    const source = '>'.repeat(2000) + ' <b>x</b>'
    const html = markdownToHtml(source)
    expect(html.startsWith('<pre>')).toBe(true)
    expect(html).toContain('&gt;&gt;&gt; &lt;b&gt;x&lt;/b&gt;</pre>')
  })
})

describe('双链切分', () => {
  it('解析 [[m-xxxxxx]] 与 [[m-xxxxxx|别名]]，短 ID 统一转成小写并裁去别名空白', () => {
    expect(splitWikiLinks('参考 [[M-ab2345|网络配置]] 与 [[m-345678]]，结束')).toEqual([
      { text: '参考 ' },
      { text: '[[M-ab2345|网络配置]]', link: { shortId: 'm-ab2345', alias: '网络配置' } },
      { text: ' 与 ' },
      { text: '[[m-345678]]', link: { shortId: 'm-345678', alias: null } },
      { text: '，结束' },
    ])
    expect(splitWikiLinks('普通文本')).toEqual([{ text: '普通文本' }])
    expect(splitWikiLinks('')).toEqual([])
  })

  it('别名为全空白时回退为无别名', () => {
    expect(splitWikiLinks('[[m-234567|   ]]')).toEqual([
      { text: '[[m-234567|   ]]', link: { shortId: 'm-234567', alias: null } },
    ])
  })
})

describe('stripInlineMarkdown 行内符号清理', () => {
  it('剥离粗体、斜体、删除线、行内代码与链接语法，同时保留双链与标识符下划线', () => {
    expect(
      stripInlineMarkdown('**关联注意点**：参考 `kioku_zh` 与 [文档](https://example.com)'),
    ).toBe('关联注意点：参考 kioku_zh 与 文档')
    expect(
      stripInlineMarkdown('见 [[m-ab2345|工作_流]] 与 **dev_profile**，~~旧方案~~ _斜体_'),
    ).toBe('见 [[m-ab2345|工作_流]] 与 dev_profile，旧方案 斜体')
    expect(stripInlineMarkdown('截断后的 **未闭合粗体')).toBe('截断后的 未闭合粗体')
    expect(stripInlineMarkdown('未闭合粗体**：说明')).toBe('未闭合粗体：说明')
  })

  it('行内代码内容原样保留，不被强调或链接规则误改，且代码内双链不转为活动双链', () => {
    expect(stripInlineMarkdown('遍历 `apps/**/*.ts` 目录')).toBe('遍历 apps/**/*.ts 目录')
    expect(stripInlineMarkdown('区分 `personal-*` 与 `work-*` 场域')).toBe(
      '区分 personal-* 与 work-* 场域',
    )
    expect(stripInlineMarkdown('覆盖 `__init__` 与 `` `嵌套` ``')).toBe('覆盖 __init__ 与 `嵌套`')

    expect(stripInlineMarkdownSegments('示例 `[[m-ab2345]]` 与 **[[m-345678|真实引用]]**')).toEqual(
      [
        { text: '示例 [[m-ab2345]] 与 ' },
        {
          text: '[[m-345678|真实引用]]',
          link: { shortId: 'm-345678', alias: '真实引用' },
        },
      ],
    )
  })

  it('保留通配符、乘号、幂运算、裸网址下划线，并正确展开含括号链接与嵌套强调', () => {
    expect(stripInlineMarkdown('匹配 *.ts 和 *.vue 文件')).toBe('匹配 *.ts 和 *.vue 文件')
    expect(stripInlineMarkdown('匹配 *.ts 文件，以及 *斜体* 文字')).toBe(
      '匹配 *.ts 文件，以及 斜体 文字',
    )
    expect(stripInlineMarkdown('计算 2 * 3 * 4 与 2**10')).toBe('计算 2 * 3 * 4 与 2**10')
    expect(stripInlineMarkdown('范围 apps/**/*.ts 和 packages/**/*.ts')).toBe(
      '范围 apps/**/*.ts 和 packages/**/*.ts',
    )
    expect(stripInlineMarkdown('见 https://example.com/_foo_/bar，_说明_')).toBe(
      '见 https://example.com/_foo_/bar，说明',
    )
    expect(stripInlineMarkdown('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('Foo')
    expect(
      stripInlineMarkdown('[![build](https://example.com/b.svg)](https://example.com/ci)'),
    ).toBe('build')
    expect(stripInlineMarkdown('__a _b_ c__ 与 ***粗斜*** 与 **bold *italic***')).toBe(
      'a b c 与 粗斜 与 bold italic',
    )
  })

  it('对大量未闭合括号或反引号保持线性时间，不发生回溯卡顿', () => {
    const cases = ['['.repeat(50_000) + 'a', '[a]('.repeat(20_000) + 'x', '`'.repeat(50_000)]
    for (const input of cases) {
      const started = performance.now()
      const out = stripInlineMarkdown(input)
      const elapsed = performance.now() - started
      expect(out.length).toBeGreaterThan(0)
      expect(elapsed).toBeLessThan(200)
    }
  })
})

const VOID_TAGS = new Set(['br', 'hr'])

function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, '&quot;')
}

function decodeEntities(raw: string): string {
  return raw.replace(/&(amp|lt|gt|quot|#x[0-9a-fA-F]+|#\d+);/g, (_, entity: string) => {
    if (entity === 'amp') return '&'
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'quot') return '"'
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16))
    }
    return String.fromCodePoint(parseInt(entity.slice(1), 10))
  })
}

type FakeChild = FakeText | FakeElement

class FakeNode {
  parent: FakeContainer | null = null
  get parentElement(): FakeElement | null {
    return this.parent instanceof FakeElement ? this.parent : null
  }
  replaceWith(replacement: FakeDocumentFragment | FakeChild | string) {
    if (!this.parent) return
    const idx = this.parent.childNodes.indexOf(this as unknown as FakeChild)
    if (idx === -1) return
    const items: FakeChild[] =
      replacement instanceof FakeDocumentFragment
        ? [...replacement.childNodes]
        : typeof replacement === 'string'
          ? [new FakeText(replacement)]
          : [replacement]
    for (const item of items) item.parent = this.parent
    this.parent.childNodes.splice(idx, 1, ...items)
    this.parent = null
  }
}

class FakeText extends FakeNode {
  data: string
  constructor(data: string) {
    super()
    this.data = data
  }
  toHtml(): string {
    return escapeXmlText(this.data)
  }
}

abstract class FakeContainer extends FakeNode {
  childNodes: FakeChild[] = []
  append(...items: (FakeDocumentFragment | FakeChild | string)[]) {
    for (const item of items) {
      if (item instanceof FakeDocumentFragment) {
        const moved = item.childNodes.splice(0)
        for (const child of moved) {
          child.parent = this
          this.childNodes.push(child)
        }
      } else if (typeof item === 'string') {
        const text = new FakeText(item)
        text.parent = this
        this.childNodes.push(text)
      } else {
        item.parent = this
        this.childNodes.push(item)
      }
    }
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeContainer) => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (child.matchesSimple(selector)) out.push(child)
          walk(child)
        }
      }
    }
    walk(this)
    return out
  }
  get innerHTML(): string {
    return this.childNodes.map((child) => child.toHtml()).join('')
  }
}

class FakeDocumentFragment extends FakeContainer {}

class FakeElement extends FakeContainer {
  tagName: string
  attrs = new Map<string, string>()
  dataset: Record<string, string | undefined>

  constructor(tagName: string) {
    super()
    this.tagName = tagName.toLowerCase()
    this.dataset = new Proxy<Record<string, string | undefined>>(
      {},
      {
        get: (_, prop: string) =>
          this.attrs.get(`data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
        set: (_, prop: string, value: string | undefined) => {
          const key = `data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
          if (value === undefined) this.attrs.delete(key)
          else this.attrs.set(key, String(value))
          return true
        },
      },
    )
  }

  get className(): string {
    return this.attrs.get('class') ?? ''
  }
  set className(value: string) {
    this.attrs.set('class', value)
  }
  get href(): string {
    return this.attrs.get('href') ?? ''
  }
  set href(value: string) {
    this.attrs.set('href', value)
  }
  get title(): string {
    return this.attrs.get('title') ?? ''
  }
  set title(value: string) {
    this.attrs.set('title', value)
  }
  set textContent(value: string) {
    this.childNodes = []
    const text = new FakeText(value)
    text.parent = this
    this.childNodes.push(text)
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  matchesSimple(selector: string): boolean {
    for (const raw of selector.split(',')) {
      const part = raw.trim()
      if (!part) continue
      if (part === 'a[href]') {
        if (this.tagName === 'a' && this.attrs.has('href')) return true
        continue
      }
      if (part.startsWith('.')) {
        const cls = part.slice(1)
        if (this.className.split(/\s+/).includes(cls)) return true
        continue
      }
      if (this.tagName === part.toLowerCase()) return true
    }
    return false
  }
  closest(selector: string): FakeElement | null {
    if (this.matchesSimple(selector)) return this
    let cur = this.parentElement
    while (cur) {
      if (cur.matchesSimple(selector)) return cur
      cur = cur.parentElement
    }
    return null
  }
  toHtml(): string {
    const attrs = [...this.attrs.entries()].map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`).join('')
    if (VOID_TAGS.has(this.tagName)) return `<${this.tagName}${attrs}>`
    return `<${this.tagName}${attrs}>${this.innerHTML}</${this.tagName}>`
  }
}

function parseSanitizedFragment(
  html: string,
  allowedTags: Set<string>,
  allowedAttrs: Set<string>,
): FakeDocumentFragment {
  const root = new FakeDocumentFragment()
  const stack: FakeContainer[] = [root]
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>|([^<]+)/g
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(html)) !== null) {
    const [, closing, rawTag, rawAttrs, selfClose, text] = match
    const parent = stack.at(-1)!
    if (text !== undefined) {
      parent.append(decodeEntities(text))
      continue
    }
    const tag = rawTag!.toLowerCase()
    if (!allowedTags.has(tag)) continue
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        const candidate = stack[i]
        if (candidate instanceof FakeElement && candidate.tagName === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    const el = new FakeElement(tag)
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
    let attr: RegExpExecArray | null
    while ((attr = attrRe.exec(rawAttrs ?? '')) !== null) {
      const name = attr[1]!.toLowerCase()
      if (!allowedAttrs.has(name)) continue
      const val = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '')
      el.setAttribute(name, val)
    }
    parent.append(el)
    if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el)
  }
  return root
}

function installFakeDom() {
  const fakeDoc = {
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    createDocumentFragment: () => new FakeDocumentFragment(),
    createTreeWalker: (root: FakeContainer) => {
      const texts: FakeText[] = []
      const walk = (node: FakeContainer) => {
        for (const child of node.childNodes) {
          if (child instanceof FakeText) texts.push(child)
          else walk(child)
        }
      }
      walk(root)
      let cursor = 0
      return {
        nextNode: () => texts[cursor++] ?? null,
      }
    },
  }
  vi.stubGlobal('document', fakeDoc)
  vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 })

  const purify = DOMPurify as unknown as {
    sanitize?: (
      dirty: string,
      config?: { ALLOWED_TAGS?: string[]; ALLOWED_ATTR?: string[] },
    ) => unknown
  }
  const previousSanitize = purify.sanitize
  purify.sanitize = (dirty, config) =>
    parseSanitizedFragment(
      dirty,
      new Set(config?.ALLOWED_TAGS ?? []),
      new Set(config?.ALLOWED_ATTR ?? []),
    )

  return () => {
    if (previousSanitize === undefined) delete purify.sanitize
    else purify.sanitize = previousSanitize
    vi.unstubAllGlobals()
  }
}

describe('renderMarkdown 双链芯片渲染', () => {
  let restoreDom: (() => void) | null = null

  beforeEach(() => {
    restoreDom = installFakeDom()
  })

  afterEach(() => {
    restoreDom?.()
    restoreDom = null
  })

  it('输出带图标 SVG 与标题标签的纸墨双链，且不泄露原始括号', () => {
    const html = renderMarkdown('补全双链：[[m-s8a8df]]、[[m-2ft6p4|自定义名称]]', {
      wikiLinks: {
        byShortId: new Map([
          ['m-s8a8df', { title: '家庭网络架构' }],
          ['m-2ft6p4', { title: '网关配置清单' }],
        ]),
        href: (sid) => `/memories?id=${sid}`,
      },
    })

    expect(html).not.toContain('[[')
    expect(html).not.toContain(']]')
    expect(html).toContain('class="kioku-wikilink"')
    expect(html).toContain('href="/memories?id=m-s8a8df"')
    expect(html).toContain('data-short-id="m-s8a8df"')
    expect(html).toContain('title="家庭网络架构（m-s8a8df）"')
    expect(html).toContain('<svg viewBox="0 0 24 24"')
    expect(html).toContain('class="kioku-wikilink-icon"')
    expect(html).toContain('M9 17H7A5 5 0 0 1 7 7h2')
    expect(html).toContain('M15 7h2a5 5 0 1 1 0 10h-2')
    expect(html).toContain('<line x1="8" x2="16" y1="12" y2="12"></line>')
    expect(html).toContain('<span class="kioku-wikilink-label">家庭网络架构</span>')
    expect(html).toContain('<span class="kioku-wikilink-label">自定义名称</span>')
    expect(html).toContain('title="网关配置清单（m-2ft6p4）"')
  })

  it('目标缺失时附加 kioku-wikilink-missing 并回退短 ID 或别名', () => {
    const html = renderMarkdown('失效引用 [[m-999999]] 与 [[m-888888|旧名称]]', {
      wikiLinks: {
        byShortId: new Map([['m-s8a8df', { title: '有效目标' }]]),
        href: (sid) => `/memories?id=${sid}`,
      },
    })

    expect(html).not.toContain('[[')
    expect(html).not.toContain(']]')
    expect(html).toContain('class="kioku-wikilink kioku-wikilink-missing"')
    expect(html).toContain('title="m-999999"')
    expect(html).toContain('<span class="kioku-wikilink-label">m-999999</span>')
    expect(html).toContain('<span class="kioku-wikilink-label">旧名称</span>')
  })

  it('恶意别名与恶意标题文本会被安全转义，不产生注入标签', () => {
    const html = renderMarkdown('测试 [[m-s8a8df|<img src=x onerror=alert(1)>]] 与 [[m-2ft6p4]]', {
      wikiLinks: {
        byShortId: new Map([
          ['m-s8a8df', { title: '安全标题' }],
          ['m-2ft6p4', { title: '<script>alert("xss")</script>' }],
        ]),
        href: (sid) => `/memories?id=${sid}`,
      },
    })

    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain(
      '<span class="kioku-wikilink-label">&lt;img src=x onerror=alert(1)&gt;</span>',
    )
    expect(html).toContain(
      '<span class="kioku-wikilink-label">&lt;script&gt;alert("xss")&lt;/script&gt;</span>',
    )
  })

  it('行内代码与围栏代码块里的双链语法保持原文不转换', () => {
    const html = renderMarkdown('行内 `[[m-s8a8df]]`\n\n```\n[[m-2ft6p4]]\n```', {
      wikiLinks: {
        byShortId: new Map([['m-s8a8df', { title: '家庭网络架构' }]]),
        href: (sid) => `/memories?id=${sid}`,
      },
    })

    expect(html).not.toContain('kioku-wikilink')
    expect(html).toContain('<code>[[m-s8a8df]]</code>')
    expect(html).toContain('[[m-2ft6p4]]')
  })
})
