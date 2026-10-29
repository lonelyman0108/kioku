import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { backupNotice, classifyError, defaultHour, formatBytes, hourLabel } from '../backup'

describe('备份的显示', () => {
  // 在有夏令时的时区里核对：UTC 钟点与本地钟点的换算要按当天，固定用冬天的日期夏天就差一小时
  const zone = process.env.TZ
  beforeAll(() => {
    process.env.TZ = 'America/New_York'
  })
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })

  it('钟点同时给出 UTC 与本地时间，大小按单位换算', () => {
    expect(hourLabel(3)).toMatch(/^03:00 UTC（本地 \d{2}:\d{2}）$/)
    // 本地的零点写成 00:00，不会是 24:00；默认的钟点换回本地正好是凌晨 3 点（夏天冬天都按当天换算）
    // 冬天、夏天，以及夏令时结束前一晚的 21 点（那时 UTC 已经是第二天）
    const days = [
      new Date('2026-01-15T12:00:00Z'),
      new Date('2026-07-15T12:00:00Z'),
      new Date('2026-11-01T01:00:00Z'),
    ]
    for (const day of days) {
      for (let hour = 0; hour < 24; hour++) expect(hourLabel(hour, day)).not.toContain('24:')
      expect(hourLabel(defaultHour(day), day)).toContain('本地 03:00')
    }
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

  it('最近的错误比最近一份晚是没做成，同时记下的是提醒', () => {
    const failed = { at: hoursAgo(1) }
    expect(classifyError(null, null)).toBeNull()
    expect(classifyError(null, failed)).toEqual({ kind: 'error', error: failed })
    expect(classifyError(hoursAgo(6), failed)?.kind).toBe('error')
    expect(classifyError(hoursAgo(6), { at: hoursAgo(6) })?.kind).toBe('warning')
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

  it('超过两天没有新的备份时提醒，比做成之后的提醒优先', () => {
    expect(backupNotice(configured({ lastSuccessAt: hoursAgo(47) }), now)).toBeNull()
    expect(backupNotice(configured({ lastSuccessAt: hoursAgo(73) }), now)).toMatchObject({
      color: 'warning',
      title: '好几天没有新的备份',
    })
    const warned = { message: '删旧备份时出错', at: hoursAgo(120) }
    expect(
      backupNotice(configured({ lastSuccessAt: hoursAgo(120), lastError: warned }), now),
    ).toMatchObject({ title: '好几天没有新的备份' })
  })
})
