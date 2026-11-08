import { SPACE_NAME_MAX, SpaceName } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { personalSpaceName } from '../accounts'

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
    expect(name.isWellFormed()).toBe(true)
    expect(SpaceName.safeParse(name).success).toBe(true)
    // 契约按码点算：多一个码点就超出
    expect(SpaceName.safeParse(`😀${name}`).success).toBe(false)
    const mixed = personalSpaceName(`a${'😀'.repeat(70)}`)
    expect(mixed.isWellFormed()).toBe(true)
    expect(SpaceName.safeParse(mixed).success).toBe(true)
  })
})
