import { beforeEach, describe, expect, it, vi } from 'vitest'

// 限流表是模块级状态，每个用例重新加载模块，互不影响
let limiter: typeof import('../rateLimit')
beforeEach(async () => {
  vi.resetModules()
  limiter = await import('../rateLimit')
})

describe('登录限流', () => {
  it('同一用户名 5 次之后拒绝，成功登录后清零', () => {
    for (let i = 0; i < 5; i++) expect(limiter.reserveAttempt('carol')).toBe(true)
    expect(limiter.reserveAttempt('carol')).toBe(false)
    limiter.clearAttempts('carol')
    expect(limiter.reserveAttempt('carol')).toBe(true)
  })

  it('用随机用户名刷满表也挤不掉已锁定的账号', () => {
    for (let i = 0; i < 5; i++) limiter.reserveAttempt('alice')
    expect(limiter.reserveAttempt('alice')).toBe(false)
    for (let i = 0; i < 25_000; i++) limiter.reserveAttempt(`spray-${i}`)
    expect(limiter.reserveAttempt('alice')).toBe(false)
  })

  it('锁定项和随机用户名一起刷，表的大小始终有上限', () => {
    for (let i = 0; i < 12_000; i++)
      for (let j = 0; j < 5; j++) limiter.reserveAttempt(`locked-${i}`)
    for (let i = 0; i < 5_000; i++) limiter.reserveAttempt(`new-${i}`)
    expect(limiter.trackedCount()).toBeLessThanOrEqual(10_000)
  })
})
