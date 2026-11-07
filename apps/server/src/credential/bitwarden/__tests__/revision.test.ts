import { describe, expect, it } from 'vitest'

import { isNewerRevision, sameRevision } from '../revision'

describe('条目修改时间的比较', () => {
  it('相差不到 1 秒算同一个：写入响应的小数秒与库里存的整秒', () => {
    expect(sameRevision('2026-11-08T10:00:04.678901Z', '2026-11-08T10:00:04.000000Z')).toBe(true)
    // MySQL 四舍五入到下一秒也算同一个
    expect(sameRevision('2026-11-08T10:00:04.678901Z', '2026-11-08T10:00:05.000000Z')).toBe(true)
    expect(sameRevision('2026-11-08T10:00:04.000Z', '2026-11-08T10:00:05.000Z')).toBe(false)
  })

  it('晚 1 秒以上才算更新，更早的或 1 秒之内的不算', () => {
    expect(isNewerRevision('2026-11-08T10:00:05.000Z', '2026-11-08T10:00:04.000Z')).toBe(true)
    expect(isNewerRevision('2026-11-08T10:00:04.900Z', '2026-11-08T10:00:04.000Z')).toBe(false)
    expect(isNewerRevision('2026-11-08T10:00:03.000Z', '2026-11-08T10:00:04.000Z')).toBe(false)
  })

  it('解析不了时按原文比', () => {
    expect(sameRevision('x', 'x')).toBe(true)
    expect(sameRevision('x', 'y')).toBe(false)
    expect(isNewerRevision('x', 'y')).toBe(true)
    expect(isNewerRevision('x', 'x')).toBe(false)
  })
})
