import { describe, expect, it } from 'vitest'

import { isDue } from '../storage'

const at = (iso: string) => new Date(iso)

describe('定时备份什么时候做', () => {
  it('每天到了钟点之后要有一份那之后做的', () => {
    // 还没到今天的钟点：昨天那个钟点之后做过就不用做
    expect(isDue(at('2026-10-29T02:00:00Z'), 3, at('2026-10-28T03:10:00Z'))).toBe(false)
    // 过了今天的钟点，最近一份是昨天的：要做
    expect(isDue(at('2026-10-29T03:30:00Z'), 3, at('2026-10-28T03:10:00Z'))).toBe(true)
    // 今天的已经做过
    expect(isDue(at('2026-10-29T03:30:00Z'), 3, at('2026-10-29T03:05:00Z'))).toBe(false)
    // 从没做过
    expect(isDue(at('2026-10-29T01:00:00Z'), 3, null)).toBe(true)
  })

  it('服务停过、做失败了，之后检查时补做', () => {
    // 钟点是 23 点，服务第二天凌晨才起来：昨天 23 点之后还没有，补做
    expect(isDue(at('2026-10-29T01:00:00Z'), 23, at('2026-10-27T23:10:00Z'))).toBe(true)
    // 23 点那一份做成了，凌晨不重复做
    expect(isDue(at('2026-10-29T01:00:00Z'), 23, at('2026-10-28T23:10:00Z'))).toBe(false)
  })
})
