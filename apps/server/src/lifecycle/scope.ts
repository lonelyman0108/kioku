import type { BootResponse, RecallCandidate } from '@kioku/contracts'

import type { Access } from '../access/access'
import type { Tx } from '../db/client'

// 召回、boot 与生命周期共用的执行范围：已解析好的权限，以及在当前空间事务里执行（附带人格链）。
// REST、MCP 与生命周期端点都只通过 recall / boot 调用，召回流程只有这一份
export interface RecallScope {
  access: Access
  run<T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>): Promise<T>
  recall(query: string, options: { limit: number; minScore?: number }): Promise<RecallCandidate[]>
  boot(): Promise<BootResponse>
}
