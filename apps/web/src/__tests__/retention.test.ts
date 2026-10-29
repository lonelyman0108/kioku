import type { RetentionCounts } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { pauseText, retentionSummary, retentionTotal } from '../retention'

const zero: RetentionCounts = {
  deletedMemories: 0,
  supersededFacts: 0,
  expiredSummaries: 0,
  orphanEvents: 0,
  scrubbedSnapshots: 0,
  extractionRuns: 0,
  credentialEvents: 0,
  deletedCredentials: 0,
  deletedProviders: 0,
}

describe('保留期清理的结果', () => {
  it('一条都没删时什么都不列', () => {
    expect(retentionSummary(zero)).toEqual([])
    expect(retentionTotal(zero)).toBe(0)
  })

  it('只列删了东西的几类，按固定的顺序', () => {
    const counts = { ...zero, deletedProviders: 1, deletedMemories: 12, credentialEvents: 3 }
    expect(retentionSummary(counts)).toEqual([
      { label: '已删除的记忆', count: 12 },
      { label: '凭据事件', count: 3 },
      { label: '已删除的凭据源', count: 1 },
    ])
    expect(retentionTotal(counts)).toBe(16)
  })
})

describe('暂停的说法', () => {
  const pause = { since: '2026-10-29T05:00:00.000Z', until: '2026-11-28T05:00:00.000Z' }

  it('从备份恢复的：说明恢复出的已删除记录早已到期，要找回的先撤销删除', () => {
    const text = pauseText({ ...pause, reason: 'restored' }, 30)
    expect(text.title).toMatch(/^从备份恢复于 .+，清理暂停到 .+$/)
    expect(text.description).toContain('恢复出的已删除记录')
    expect(text.confirm).toContain('删除超过 30 天的会被永久删除')
  })

  it('保留期第一次生效的：说明之前删掉的还有一个完整的保留期可以撤销', () => {
    const text = pauseText({ ...pause, reason: 'started' }, 7)
    expect(text.title).toMatch(/^保留期从 .+ 开始生效，第一次清理在 .+$/)
    expect(text.description).toContain('之前删掉的到现在都还能撤销')
    expect(text.description).toContain('删账号留下的历史照常每天清理')
    expect(text.confirm).toContain('已经删除超过 7 天的')
  })
})
