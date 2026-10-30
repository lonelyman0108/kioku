import { Tokenizer } from 'marked'
import { describe, expect, it, vi } from 'vitest'

import { markdownToHtml, rawHtml } from '../markdown'

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
