import { describe, expect, it } from 'vitest'

import { generateSetupCode, SetupGate } from '../setupCode'

describe('初始化码', () => {
  it('随机生成的码按四位一组，比对时不看连字符、空白与大小写', () => {
    const gate = new SetupGate(null)
    const code = gate.open()
    // 26 位、每位 32 种：130 位熵
    expect(code.replaceAll('-', '')).toMatch(/^[A-HJ-NP-Z2-9]{26}$/)
    expect(code).toMatch(/^([A-Z2-9]{4}-){6}[A-Z2-9]{2}$/)
    expect(gate.open()).toBe(code)
    expect(gate.verify(` ${code.replaceAll('-', '').toLowerCase()} `, 'a')).toBe('ok')
    expect(generateSetupCode()).not.toBe(code)
  })

  it('设了固定的码时用它', () => {
    const gate = new SetupGate('my-fixed-code')
    expect(gate.open()).toBe('my-fixed-code')
    expect(gate.verify('MYFIXEDCODE', null)).toBe('ok')
    expect(gate.verify('my-fixed-cod', null)).toBe('wrong')
  })

  it('没打开或作废之后一律是 closed', () => {
    const gate = new SetupGate('abcdefgh')
    expect(gate.verify('abcdefgh', null)).toBe('closed')
    gate.open()
    gate.close()
    expect(gate.isOpen).toBe(false)
    expect(gate.verify('abcdefgh', null)).toBe('closed')
  })

  it('同一客户端错 5 次之后不再比对，过了窗口期恢复；成功清掉本客户端的计数', () => {
    let now = 0
    const gate = new SetupGate('abcdefgh', () => now)
    gate.open()
    for (let i = 0; i < 4; i++) expect(gate.verify('wrong-code', 'a')).toBe('wrong')
    expect(gate.verify('abcdefgh', 'a')).toBe('ok')
    for (let i = 0; i < 5; i++) expect(gate.verify('wrong-code', 'a')).toBe('wrong')
    // 超限之后连正确的码也不比对
    expect(gate.verify('abcdefgh', 'a')).toBe('limited')
    // 别的客户端不受影响
    expect(gate.verify('abcdefgh', 'b')).toBe('ok')
    now += 15 * 60_000
    expect(gate.verify('abcdefgh', 'a')).toBe('ok')
  })

  it('没有全实例的合计上限：许多来源都猜错，部署的人仍能用码', () => {
    const gate = new SetupGate('abcdefgh')
    gate.open()
    for (let i = 0; i < 2000; i++) expect(gate.verify('wrong-code', `c${i}`)).toBe('wrong')
    expect(gate.verify('abcdefgh', 'owner')).toBe('ok')
  })

  it('按客户端记的条目有上限，满了丢掉最早的', () => {
    const gate = new SetupGate('abcdefgh')
    gate.open()
    for (let i = 0; i < 5; i++) gate.verify('wrong-code', 'first')
    expect(gate.verify('abcdefgh', 'first')).toBe('limited')
    for (let i = 0; i < 10_000; i++) gate.verify('wrong-code', `c${i}`)
    // first 被挤掉了，重新计数
    expect(gate.verify('abcdefgh', 'first')).toBe('ok')
  })
})
