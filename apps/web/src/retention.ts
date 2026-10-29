import type { RetentionCounts } from '@kioku/contracts'

// 一次清理每一类删了多少：卡片上按这个顺序列
export const retentionLabels: Record<keyof RetentionCounts, string> = {
  deletedMemories: '已删除的记忆',
  supersededFacts: '被推翻的事实',
  expiredSummaries: '过期的会话摘要',
  orphanEvents: '记忆已经不在的历史',
  scrubbedSnapshots: '抹掉正文的历史快照',
  extractionRuns: '抽取记录',
  credentialEvents: '凭据事件',
  deletedCredentials: '已删除的凭据',
  deletedProviders: '已删除的凭据源',
}

// 删了东西的那几类，一条都没删的不列
export function retentionSummary(counts: RetentionCounts): { label: string; count: number }[] {
  return (Object.keys(retentionLabels) as (keyof RetentionCounts)[])
    .filter((kind) => counts[kind] > 0)
    .map((kind) => ({ label: retentionLabels[kind], count: counts[kind] }))
}
