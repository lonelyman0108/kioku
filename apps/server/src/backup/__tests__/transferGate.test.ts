import { describe, expect, it } from 'vitest'

import { MemoryError } from '../../memory/service'
import { acquireTransferSlot, queuedTransfers, withTransferSlot } from '../transferGate'

const busy = (p: Promise<unknown>) =>
  expect(p).rejects.toSatisfy((err) => err instanceof MemoryError && err.status === 429)

// 名额交接要等排着的那个继续往下走
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('导出导入的闸门', () => {
  it('同时只做一个，排队最多 4 个，满了直接拒绝（429），放开之后照常', async () => {
    const first = await acquireTransferSlot('a0')
    const queued = Array.from({ length: 4 }, (_, i) => acquireTransferSlot(`a${i + 1}`))
    expect(queuedTransfers()).toBe(4)
    await busy(acquireTransferSlot('a5'))
    // 一个做完，名额直接交给排在最前面的，后面的接着排
    first()
    const second = await queued[0]!
    expect(queuedTransfers()).toBe(3)
    second()
    for (const next of queued.slice(1)) (await next)()
    expect(queuedTransfers()).toBe(0)
    ;(await acquireTransferSlot('a5'))()
  })

  it('每个账号同时只占一个名额：排着的也算，别的账号照样排得进去', async () => {
    const holder = await acquireTransferSlot('holder')
    const mine = acquireTransferSlot('same')
    await busy(acquireTransferSlot('same'))
    const other = acquireTransferSlot('other')
    holder()
    ;(await mine)()
    ;(await other)()
    ;(await acquireTransferSlot('same'))()
  })

  it('放名额的函数调几次都只放一次', async () => {
    const release = await acquireTransferSlot('twice')
    const next = acquireTransferSlot('next')
    release()
    release()
    const nextRelease = await next
    // 第二次调用没有把名额再放一次：别人进来时仍要排队
    const later = acquireTransferSlot('later')
    await settle()
    expect(queuedTransfers()).toBe(1)
    nextRelease()
    ;(await later)()
  })

  it('排着队时请求断开：从队列里移除、放掉名额，同一个账号马上能再排', async () => {
    const holder = await acquireTransferSlot('holder')
    const controller = new AbortController()
    const waiting = acquireTransferSlot('leaver', controller.signal)
    expect(queuedTransfers()).toBe(1)
    await busy(acquireTransferSlot('leaver'))
    controller.abort()
    await expect(waiting).rejects.toThrow('请求已断开')
    expect(queuedTransfers()).toBe(0)
    const again = acquireTransferSlot('leaver')
    expect(queuedTransfers()).toBe(1)
    holder()
    ;(await again)()
    // 已经断开的请求不再排
    await expect(acquireTransferSlot('late', AbortSignal.abort())).rejects.toThrow('请求已断开')
    expect(queuedTransfers()).toBe(0)
  })

  it('占着名额做一件事：做完或出错都放掉', async () => {
    await expect(
      withTransferSlot('worker', undefined, async () => {
        throw new Error('坏了')
      }),
    ).rejects.toThrow('坏了')
    expect(await withTransferSlot('worker', undefined, async () => 1)).toBe(1)
    const next = acquireTransferSlot('next')
    expect(queuedTransfers()).toBe(0)
    ;(await next)()
  })

  it('轮到之后才断开不影响已经拿到的名额', async () => {
    const holder = await acquireTransferSlot('holder')
    const controller = new AbortController()
    const waiting = acquireTransferSlot('runner', controller.signal)
    holder()
    const release = await waiting
    controller.abort()
    const next = acquireTransferSlot('next')
    await settle()
    expect(queuedTransfers()).toBe(1)
    release()
    ;(await next)()
  })
})
