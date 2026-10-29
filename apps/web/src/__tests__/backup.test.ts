import { describe, expect, it } from 'vitest'

import { backupNotice, formatBytes, hourLabel } from '../backup'

describe('备份的显示', () => {
  it('钟点同时给出 UTC 与本地时间，大小按单位换算', () => {
    expect(hourLabel(3)).toMatch(/^03:00 UTC（本地 \d{2}:\d{2}）$/)
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB')
  })
})

describe('概览里的备份提醒', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  const hoursAgo = (n: number) => new Date(now.getTime() - n * 3_600_000).toISOString()
  const configured = (extra: object = {}) => ({
    configured: true,
    lastSuccessAt: hoursAgo(6),
    lastError: null,
    ...extra,
  })

  it('不是实例管理员、或者一切正常时不提醒', () => {
    expect(backupNotice(null, now)).toBeNull()
    expect(backupNotice(configured(), now)).toBeNull()
  })

  it('没配备份、还没做过一份时提示', () => {
    expect(
      backupNotice({ configured: false, lastSuccessAt: null, lastError: null }, now),
    ).toMatchObject({ color: 'info', title: '还没配备份' })
    expect(backupNotice(configured({ lastSuccessAt: null }), now)).toMatchObject({
      color: 'info',
      title: '还没做过备份',
    })
  })

  it('最近一次没做成时报错；做成了但有提醒时提醒', () => {
    const failed = { message: '存储返回 403（AccessDenied）', at: hoursAgo(1) }
    expect(backupNotice(configured({ lastError: failed }), now)).toMatchObject({
      color: 'error',
      title: '备份没做成',
    })
    const warned = { message: '备份已经传上去，但删旧备份时出错', at: hoursAgo(6) }
    expect(backupNotice(configured({ lastError: warned }), now)).toMatchObject({
      color: 'warning',
      description: warned.message,
    })
  })

  it('超过两天没有新的备份时提醒', () => {
    expect(backupNotice(configured({ lastSuccessAt: hoursAgo(47) }), now)).toBeNull()
    expect(backupNotice(configured({ lastSuccessAt: hoursAgo(73) }), now)).toMatchObject({
      color: 'warning',
      title: '好几天没有新的备份',
    })
  })
})
