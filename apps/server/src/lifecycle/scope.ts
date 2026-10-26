import type { BootResponse, RecallCandidate, RecentMemory } from '@kioku/contracts'

// 召回与 boot 的执行范围：权限、空间与人格链都已绑定。
// REST、MCP 与生命周期端点都只通过它调用，召回流程只有这一份
export interface RecallScope {
  recall(query: string, options: { limit: number; minScore?: number }): Promise<RecallCandidate[]>
  boot(): Promise<BootResponse>
  recent(limit: number): Promise<RecentMemory[]>
}
