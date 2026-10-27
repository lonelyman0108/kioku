import { describe, expect, it } from 'vitest'

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
    expect(markdownToHtml('![**粗** 图](https://example.com/x.png "说明")')).toBe(
      '<p><a href="https://example.com/x.png" title="说明">粗 图</a></p>\n',
    )
  })

  it('替代文字里的字符引用不重复转义', () => {
    const html = markdownToHtml('![&copy; 2024](https://example.com/x.png)')
    expect(html).toContain('>&copy; 2024</a>')
    expect(html).not.toContain('&amp;copy;')
  })

  it('嵌套太深、marked 渲染出错时退回转义后的原文', () => {
    const source = '>'.repeat(2000) + ' <b>x</b>'
    const html = markdownToHtml(source)
    expect(html.startsWith('<pre>')).toBe(true)
    expect(html).toContain('&gt;&gt;&gt; &lt;b&gt;x&lt;/b&gt;</pre>')
  })
})
