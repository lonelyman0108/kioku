import { describe, expect, it } from 'vitest'

import { deriveTitle, firstHeading } from '../uri'

describe('不给标题时的标题', () => {
  const title = (content: string) => deriveTitle(content, 'notes/router', 'private')

  it('取正文第一个 # 标题，没有就用标识；机密只用标识', () => {
    expect(title('说明\n## 家里的路由器 ##\n# 别的')).toBe('家里的路由器')
    expect(title('没有标题')).toBe('router')
    expect(deriveTitle('# 家里的路由器', 'notes/router', 'secret')).toBe('router')
  })

  it('Windows 的换行：行尾的 \\r 先去掉再认', () => {
    expect(title('# 家里的路由器\r\n正文\r\n')).toBe('家里的路由器')
    expect(title('# 家里的路由器 #\r\n')).toBe('家里的路由器')
    expect(title('```\r\n# 代码里的\r\n```\r\n# 家里的路由器\r\n')).toBe('家里的路由器')
  })

  it('代码块照 CommonMark：结束的围栏是同一种字符、不短于开头、后面没有信息串', () => {
    // 比开头短的不结束
    expect(title('````md\n```\n# 代码里的\n````\n# 家里的路由器')).toBe('家里的路由器')
    // 带信息串的不结束，是代码块里的一行
    expect(title('```js\n```python\n# 代码里的\n```\n# 家里的路由器')).toBe('家里的路由器')
    // 另一种字符的不结束
    expect(title('~~~\n```\n# 代码里的\n~~~\n# 家里的路由器')).toBe('家里的路由器')
    // 更长的、后面只有空白的、缩进不到四格的都结束
    expect(title('```\n# 代码里的\n`````  \n# 家里的路由器')).toBe('家里的路由器')
    expect(title('   ~~~\n# 代码里的\n  ~~~~\t\n# 家里的路由器')).toBe('家里的路由器')
    // 没有结束的代码块到正文结尾为止
    expect(title('```\n# 代码里的')).toBe('router')
    // ` 的信息串里有 ` 的不是围栏
    expect(title('``` a`b\n# 家里的路由器')).toBe('家里的路由器')
  })

  it('第一个 # 标题带凭据占位符时不取，也不往后找', () => {
    expect(firstHeading('# 用 {{cred:vpn}} 登录\n# 别的')).toBeNull()
    expect(title('# 用 {{cred:vpn}} 登录\n# 别的')).toBe('router')
  })
})
