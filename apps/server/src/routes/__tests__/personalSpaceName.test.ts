import { SPACE_NAME_MAX, SpaceName } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { personalSpaceName } from '../accounts'

// 有落单的代理项时 encodeURIComponent 报错
const wellFormed = (s: string) => {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

describe('个人空间的名字', () => {
  it('短的显示名照原样加后缀', () => {
    expect(personalSpaceName('BOB')).toBe('BOB的空间')
  })

  it('长的显示名截到放得下后缀，结果符合空间名的契约', () => {
    const name = personalSpaceName('字'.repeat(64))
    expect(name).toHaveLength(SPACE_NAME_MAX)
    expect(name.endsWith('的空间')).toBe(true)
    expect(SpaceName.safeParse(name).success).toBe(true)
  })

  it('emoji 按码点截，不切开代理对，结果符合契约', () => {
    const name = personalSpaceName('😀'.repeat(64))
    expect(name).toBe(`${'😀'.repeat(SPACE_NAME_MAX - 3)}的空间`)
    expect(wellFormed(name)).toBe(true)
    expect(SpaceName.safeParse(name).success).toBe(true)
    expect(wellFormed('😀'.slice(0, 1))).toBe(false)
    // 契约按码点算：多一个码点就超出
    expect(SpaceName.safeParse(`😀${name}`).success).toBe(false)
    const mixed = personalSpaceName(`a${'😀'.repeat(70)}`)
    expect(wellFormed(mixed)).toBe(true)
    expect(SpaceName.safeParse(mixed).success).toBe(true)
  })
})
