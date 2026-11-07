import { describe, expect, it, vi } from 'vitest'

import { deriveMasterKey } from '../crypto'

// Argon2id 换成计数的假实现：看同时在跑的有几个
const running = { now: 0, max: 0, calls: 0 }
vi.mock('hash-wasm', () => ({
  argon2id: vi.fn(async () => {
    running.now++
    running.calls++
    running.max = Math.max(running.max, running.now)
    await new Promise((resolve) => setTimeout(resolve, 10))
    running.now--
    if (running.calls === 2) throw new Error('派生失败')
    return new Uint8Array(32)
  }),
}))

const ARGON2 = { kind: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 } as const

describe('密钥派生排队', () => {
  it('同时来的几次登录一次只跑一个，前一个失败不挡后面的', async () => {
    const results = await Promise.allSettled([
      deriveMasterKey('a', 'a@example.com', ARGON2),
      deriveMasterKey('b', 'b@example.com', ARGON2),
      deriveMasterKey('c', 'c@example.com', ARGON2),
      deriveMasterKey('d', 'd@example.com', { kind: 'pbkdf2', iterations: 5000 }),
    ])
    expect(running.max).toBe(1)
    expect(running.calls).toBe(3)
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
    ])
  })
})
