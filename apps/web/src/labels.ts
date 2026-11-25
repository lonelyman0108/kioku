import {
  DREAM_KIND_NAMES,
  type DreamOutcome,
  type DreamSuggestionKind,
  type DreamTrigger,
  type EntryEventType,
  type EntryKind,
  type EntryTab,
} from '@kioku/contracts'

export const entryKindLabels: Record<EntryKind, string> = {
  entry: '正式记忆',
  episode: '会话摘要',
}

export const entryTabLabels: Record<EntryTab, string> = {
  all: '全部',
  pinned: '常驻',
  episodes: '近期摘要',
  trash: '回收站',
}

export const envLabels: Record<string, string> = {
  mac: 'macOS',
  linux: 'Linux',
  win: 'Windows',
}

export function envDisplayName(slug: string): string {
  return envLabels[slug] ?? slug
}

export const eventTypeLabels: Record<EntryEventType, string> = {
  create: '创建',
  update: '修改',
  delete: '删除',
  undelete: '恢复',
  restore: '恢复历史版本',
}

export const dreamKindLabels: Record<DreamSuggestionKind, string> = DREAM_KIND_NAMES

export const dreamTriggerLabels: Record<DreamTrigger, string> = {
  scheduled: '定时整理',
  manual: '手动整理',
}

export const dreamOutcomeLabels: Record<DreamOutcome, string> = {
  ok: '完成',
  skipped: '跳过',
  failed: '失败',
}
