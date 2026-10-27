import { describe, expect, it } from 'vitest'

import { rawHtml } from '../markdown'

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
