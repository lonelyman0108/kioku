import { SPACE_NAME_MAX, SpaceName } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { personalSpaceName } from '../accounts'

describe('个人空间的名字', () => {
  it('短的显示名照原样加后缀', () => {
    expect(personalSpaceName('BOB')).toBe('BOB的空间')
  })

  it('长的显示名按码元截到放得下后缀，结果符合空间名的契约', () => {
    const name = personalSpaceName('字'.repeat(64))
    expect(name).toHaveLength(SPACE_NAME_MAX)
    expect(name.endsWith('的空间')).toBe(true)
    expect(SpaceName.safeParse(name).success).toBe(true)
  })

  it('emoji 按两个码元算，截断不切开代理对', () => {
    // 32 个 emoji 是 64 个码元，按码点截到 60 个的话超出上限；截到 61 个码元正好落在代理对中间
    const name = personalSpaceName('😀'.repeat(32))
    expect(name).toBe(`${'😀'.repeat(30)}的空间`)
    expect(name.isWellFormed()).toBe(true)
    expect(SpaceName.safeParse(name).success).toBe(true)
    // 截断处正好在两个 emoji 之间
    const even = personalSpaceName(`a${'😀'.repeat(31)}`)
    expect(even).toBe(`a${'😀'.repeat(30)}的空间`)
    expect(even).toHaveLength(SPACE_NAME_MAX)
    expect(SpaceName.safeParse(even).success).toBe(true)
  })
})
