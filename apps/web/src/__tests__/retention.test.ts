import type { RetentionCounts } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { retentionSummary } from '../retention'

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
  })

  it('只列删了东西的几类，按固定的顺序', () => {
    expect(
      retentionSummary({ ...zero, deletedProviders: 1, deletedMemories: 12, credentialEvents: 3 }),
    ).toEqual([
      { label: '已删除的记忆', count: 12 },
      { label: '凭据事件', count: 3 },
      { label: '已删除的凭据源', count: 1 },
    ])
  })
})
