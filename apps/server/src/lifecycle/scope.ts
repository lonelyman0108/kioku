import type {
  EntryKind,
  RecallSource,
  RecentEntry,
  SessionSummary,
  SubjectFacts,
  WhenCondition,
} from '@kioku/contracts'

import type { BootResult } from '../recall/boot'
import type { RecordableCandidate } from '../recall/recall'
import type { EffectiveSettings } from '../settings/advanced'

// 召回与启动加载的执行范围：圈授权矩阵、会话上下文、人格与在场焦点都已绑定
export interface ScopeRecallOptions {
  limit?: number
  minScore?: number
  relevanceFloor?: number
  semantic?: boolean
  trustedOnly?: boolean
  kinds?: EntryKind[]
  facets?: WhenCondition
  crossCircle?: boolean
  disableFlipping?: boolean
  semanticTimeoutMs?: number
}

export interface RecallScope {
  readonly primaryCircleId: string
  focus(): Promise<WhenCondition>
  settings(): Promise<EffectiveSettings>
  recall(query: string, options: ScopeRecallOptions): Promise<RecordableCandidate[]>
  boot(budget?: number | ((settings: EffectiveSettings) => number)): Promise<BootResult>
  recent(limit: number): Promise<RecentEntry[]>
  summaries(limit: number): Promise<SessionSummary[]>
  subjects(): Promise<SubjectFacts[]>
  contents(ids: readonly string[]): Promise<Map<string, string>>
  record(source: RecallSource, query: string, hits: readonly RecordableCandidate[]): void
}
