import { describe, expect, it } from 'vitest'

import { PasswordGateBusy, withPasswordGate } from '../passwordGate'

describe('密码校验并发闸门', () => {
  it('同时最多运行 4 个，超出排队，排队满了直接拒绝', async () => {
    let running = 0
    let peak = 0
    const release: (() => void)[] = []
    const task = () =>
      withPasswordGate(async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise<void>((r) => release.push(r))
        running--
        return true
      })
    const accepted = Array.from({ length: 36 }, () => task())
    await expect(task()).rejects.toBeInstanceOf(PasswordGateBusy)
    while (release.length) {
      release.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    await Promise.all(accepted)
    expect(peak).toBe(4)
  })
})
