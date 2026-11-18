import { describe, expect, it } from 'vitest'

import {
  bold,
  dim,
  displayWidth,
  formatRows,
  green,
  padDisplay,
  red,
  renderStrataBox,
  stripAnsi,
  supportsColor,
  yellow,
} from '../format'

describe('CLI 地层风排版与宽度工具', () => {
  it('正确计算 ASCII、中文与 ANSI 控制序列的显示宽度', () => {
    expect(displayWidth('kioku')).toBe(5)
    expect(displayWidth('记忆')).toBe(4)
    expect(displayWidth('Kioku · 记忆')).toBe(12)
    expect(displayWidth('┌─ 诊断 ─┐')).toBe(10)
    expect(displayWidth('● ◐ ○ ✓ ! ✕')).toBe(11)

    const colored = `${green('✓ 就绪', { isTTY: true }, {})} ${dim('详情', { isTTY: true }, {})}`
    expect(stripAnsi(colored)).toBe('✓ 就绪 详情')
    expect(displayWidth(colored)).toBe(11)
  })

  it('padDisplay 按显示宽度补齐空格', () => {
    expect(padDisplay('版本', 6)).toBe('版本  ')
    const styled = bold('版本', { isTTY: true }, {})
    const padded = padDisplay(styled, 6)
    expect(stripAnsi(padded)).toBe('版本  ')
    expect(displayWidth(padded)).toBe(6)
  })

  it('非终端或设置了 NO_COLOR / TERM=dumb 时不输出 ANSI 颜色', () => {
    expect(supportsColor({ isTTY: false }, {})).toBe(false)
    expect(supportsColor({ isTTY: true }, {})).toBe(true)
    expect(supportsColor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(supportsColor({ isTTY: true }, { TERM: 'dumb' })).toBe(false)

    expect(green('通过', { isTTY: false }, {})).toBe('通过')
    expect(yellow('警告', { isTTY: true }, { NO_COLOR: '1' })).toBe('警告')
    expect(red('错误', { isTTY: true }, { TERM: 'dumb' })).toBe('错误')
    expect(green('通过', { isTTY: true }, {})).not.toBe('通过')
  })

  it('formatRows 按最宽标签等宽对齐', () => {
    const rows = formatRows(
      [
        ['版本', 'v0.4.0'],
        ['主密钥', '已配置'],
      ],
      { stream: { isTTY: false }, env: {} },
    )
    expect(rows).toEqual(['版本    v0.4.0', '主密钥  已配置'])
  })

  it('renderStrataBox 在纯文本与着色模式下每行显示宽度完全一致', () => {
    const plainBox = renderStrataBox(
      'Kioku · 诊断',
      ['版本    v0.4.0', { divider: true }, '数据库  ● 已就绪'],
      { stream: { isTTY: false }, env: {}, badge: 'v0.4.0' },
    )
    const plainLines = plainBox.split('\n')
    expect(plainLines).toHaveLength(5)
    expect(plainLines[0]?.startsWith('┌─ Kioku · 诊断 ')).toBe(true)
    expect(plainLines[0]?.endsWith(' v0.4.0 ─┐')).toBe(true)
    expect(plainLines[2]).toMatch(/^├─+┤$/)
    expect(plainLines[4]).toMatch(/^└─+┘$/)
    const widths = new Set(plainLines.map((line) => displayWidth(line)))
    expect(widths.size).toBe(1)

    const colorBox = renderStrataBox(
      'Kioku · 诊断',
      [
        `${dim('版本', { isTTY: true }, {})}  ${green('v0.4.0', { isTTY: true }, {})}`,
        '数据库  已就绪',
      ],
      { stream: { isTTY: true }, env: {}, badge: 'v0.4.0' },
    )
    const colorLines = colorBox.split('\n')
    expect(new Set(colorLines.map((line) => displayWidth(line))).size).toBe(1)
  })
})
