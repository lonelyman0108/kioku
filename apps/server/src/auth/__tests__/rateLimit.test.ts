import { describe, expect, it } from 'vitest'

import { clearAttempts, reserveAttempt } from '../rateLimit'

describe('登录限流', () => {
  it('同一用户名 5 次之后拒绝，成功登录后清零', () => {
    for (let i = 0; i < 5; i++) expect(reserveAttempt('carol')).toBe(true)
    expect(reserveAttempt('carol')).toBe(false)
    clearAttempts('carol')
    expect(reserveAttempt('carol')).toBe(true)
  })

  it('用随机用户名刷满表也挤不掉已锁定的账号', () => {
    for (let i = 0; i < 5; i++) reserveAttempt('alice-locked')
    expect(reserveAttempt('alice-locked')).toBe(false)
    for (let i = 0; i < 25_000; i++) reserveAttempt(`spray-${i}`)
    expect(reserveAttempt('alice-locked')).toBe(false)
  })
})
