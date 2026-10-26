import type { Access } from '../access/access'
import type { Tx } from '../db/client'
import type { Embedder } from '../embedding/provider'

// 召回、boot 与生命周期共用的执行范围：已解析好的权限、在当前空间事务里执行（附带人格链）、当前嵌入模型
export interface RecallScope {
  access: Access
  run<T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>): Promise<T>
  embedder(): Promise<Embedder | null>
}
