import { CIRCLE_NAME_MAX, CircleName } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { personalCircleName } from '../accounts'

const wellFormed = (s: string) => {
  try {
    encodeURIComponent(s)
    return true
  } catch {
    return false
  }
}

describe('个人圈的名字', () => {
  it('短的显示名照原样加后缀', () => {
    expect(personalCircleName('BOB')).toBe('BOB的个人圈')
  })

  it('长的显示名截到放得下后缀，结果符合记忆圈名的契约', () => {
    const name = personalCircleName('字'.repeat(64))
    expect(name).toHaveLength(CIRCLE_NAME_MAX)
    expect(name.endsWith('的个人圈')).toBe(true)
    expect(CircleName.safeParse(name).success).toBe(true)
  })

  it('emoji 按码点截，不切开代理对，结果符合契约', () => {
    const name = personalCircleName('😀'.repeat(64))
    expect(name).toBe(`${'😀'.repeat(CIRCLE_NAME_MAX - 4)}的个人圈`)
    expect(wellFormed(name)).toBe(true)
    expect(CircleName.safeParse(name).success).toBe(true)
    expect(wellFormed('😀'.slice(0, 1))).toBe(false)
    expect(CircleName.safeParse(`😀${name}`).success).toBe(false)
    const mixed = personalCircleName(`a${'😀'.repeat(70)}`)
    expect(wellFormed(mixed)).toBe(true)
    expect(CircleName.safeParse(mixed).success).toBe(true)
  })
})
