import { describe, expect, it } from 'vitest'

import { PasswordGateBusy, withPasswordGate } from '../passwordGate'

describe('密码校验并发闸门', () => {
  it('同时最多运行 4 个，超出排队，排队满了直接拒绝', async () => {
    let running = 0
    let peak = 0
    const release: (() => void)[] = []
    let n = 0
    // 每个任务来自不同客户端，只测全局并发与排队
    const task = () =>
      withPasswordGate(`client-${n++}`, async () => {
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

  it('同一个客户端同时最多占 2 个名额', async () => {
    const release: (() => void)[] = []
    const hold = () =>
      withPasswordGate('same', () => new Promise<boolean>((r) => release.push(() => r(true))))
    const a = hold()
    const b = hold()
    await expect(hold()).rejects.toBeInstanceOf(PasswordGateBusy)
    await expect(withPasswordGate('other', async () => true)).resolves.toBe(true)
    release.forEach((r) => r())
    await Promise.all([a, b])
    await expect(withPasswordGate('same', async () => true)).resolves.toBe(true)
  })
})
