import { deriveEntryTitle, firstMarkdownHeading } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

describe('不给标题时的标题提取', () => {
  const title = (content: string) =>
    deriveEntryTitle(undefined, [{ content }], 'm-router', 'private')

  it('取正文第一个 # 标题，没有就用短 ID 兜底；机密只用短 ID', () => {
    expect(title('说明\n## 家里的路由器 ##\n# 别的')).toBe('家里的路由器')
    expect(title('没有标题')).toBe('m-router')
    expect(deriveEntryTitle(undefined, [{ content: '# 家里的路由器' }], 'm-router', 'secret')).toBe(
      'm-router',
    )
  })

  it('Windows 的换行：行尾的 \\r 先去掉再认', () => {
    expect(title('# 家里的路由器\r\n正文\r\n')).toBe('家里的路由器')
    expect(title('# 家里的路由器 #\r\n')).toBe('家里的路由器')
    expect(title('```\r\n# 代码里的\r\n```\r\n# 家里的路由器\r\n')).toBe('家里的路由器')
  })

  it('代码块照 CommonMark：结束的围栏是同一种字符、不短于开头、后面没有信息串', () => {
    expect(title('````md\n```\n# 代码里的\n````\n# 家里的路由器')).toBe('家里的路由器')
    expect(title('```js\n```python\n# 代码里的\n```\n# 家里的路由器')).toBe('家里的路由器')
    expect(title('~~~\n```\n# 代码里的\n~~~\n# 家里的路由器')).toBe('家里的路由器')
    expect(title('```\n# 代码里的\n`````  \n# 家里的路由器')).toBe('家里的路由器')
    expect(title('   ~~~\n# 代码里的\n  ~~~~\t\n# 家里的路由器')).toBe('家里的路由器')
    expect(title('```\n# 代码里的')).toBe('m-router')
    expect(title('``` a`b\n# 家里的路由器')).toBe('家里的路由器')
  })

  it('第一个 # 标题带凭据占位符时不取，也不往后找', () => {
    expect(firstMarkdownHeading('# 用 {{cred:vpn}} 登录\n# 别的')).toBeNull()
    expect(title('# 用 {{cred:vpn}} 登录\n# 别的')).toBe('m-router')
  })
})
