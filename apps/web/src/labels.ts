import {
  DREAM_KIND_NAMES,
  type DreamOutcome,
  type DreamSuggestionKind,
  type DreamTrigger,
  type EntryActorKind,
  type EntryActorMeta,
  type EntryEventType,
  type EntryKind,
  type EntryTab,
  type HygieneSweepFixKind,
} from '@kioku/contracts'

import { runtimeName } from './runtimes'

export const entryKindLabels: Record<EntryKind, string> = {
  entry: '正式记忆',
  episode: '会话摘要',
}

export const entryTabLabels: Record<EntryTab, string> = {
  all: '全部',
  pinned: '常驻',
  regular: '按需',
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
  archive_note: '历史归档',
}

export const entryFieldLabels: Record<string, string> = {
  title: '标题',
  summary: '现行概要',
  content: '正文',
  disclosure: '触发场景',
  isPinned: '常驻',
  topics: '主题',
  envs: '环境',
  realms: '场域',
  projects: '项目',
  runtimes: '客户端',
  validTo: '有效期',
  kind: '类型',
  verifiedAt: '核实时间',
}

export function entryFieldLabel(field: string): string {
  return entryFieldLabels[field] ?? field
}

export const hygieneFixLabels: Record<HygieneSweepFixKind, string> = {
  strip_duplicate_heading: '移除首行重复标题',
  strip_legacy_glossary: '清理旧版关键词行',
  rewrite_legacy_links: '修复旧路径引用为双链',
}

const RAW_KEY_PREFIX = 'key:'

export type ActorFilterGroup = 'self' | 'agent' | 'dream'

// 将事件来源归一化为可读中文标注与筛选分组，避免把内部前缀暴露到界面
export function resolveActorDisplay(
  actor: string,
  actorMeta?: EntryActorMeta | null,
): { kind: EntryActorKind; label: string; group: ActorFilterGroup } {
  if (actorMeta) {
    const cleanLabel =
      actorMeta.label.trim() && !actorMeta.label.trim().toLowerCase().startsWith(RAW_KEY_PREFIX)
        ? actorMeta.label.trim()
        : actorMeta.kind === 'agent' && actorMeta.runtimeFamily
          ? runtimeName(actorMeta.runtimeFamily)
          : fallbackLabelForKind(actorMeta.kind)
    return {
      kind: actorMeta.kind,
      label: cleanLabel,
      group: groupForKind(actorMeta.kind),
    }
  }

  const normalized = actor.trim().toLowerCase()
  if (normalized === 'console') {
    return { kind: 'console', label: '本人 · 控制台', group: 'self' }
  }
  if (normalized === 'capture') {
    return { kind: 'capture', label: '本人 · 随手记', group: 'self' }
  }
  if (normalized === 'dream') {
    return { kind: 'dream', label: '后台整理', group: 'dream' }
  }
  if (normalized === 'extraction') {
    return { kind: 'extraction', label: '自动摘要', group: 'dream' }
  }
  if (
    normalized === 'system' ||
    normalized === 'hygiene' ||
    normalized === 'hygiene:sweep' ||
    normalized === 'hygiene_sweep'
  ) {
    return { kind: 'system', label: '结构预清洗', group: 'dream' }
  }
  if (normalized === 'import:lore') {
    return { kind: 'system', label: '数据导入（Lore）', group: 'dream' }
  }
  if (normalized === 'import:kioku') {
    return { kind: 'system', label: '数据导入', group: 'dream' }
  }
  if (normalized.startsWith(RAW_KEY_PREFIX)) {
    return { kind: 'agent', label: '访问密钥', group: 'agent' }
  }
  return {
    kind: 'system',
    label: actor.trim() || '系统',
    group: 'dream',
  }
}

function fallbackLabelForKind(kind: EntryActorKind): string {
  switch (kind) {
    case 'console':
      return '本人 · 控制台'
    case 'capture':
      return '本人 · 随手记'
    case 'agent':
      return '访问密钥'
    case 'dream':
      return '后台整理'
    case 'extraction':
      return '自动摘要'
    case 'system':
      return '系统'
  }
}

function groupForKind(kind: EntryActorKind): ActorFilterGroup {
  if (kind === 'console' || kind === 'capture') return 'self'
  if (kind === 'agent') return 'agent'
  return 'dream'
}

export function formatActorLabel(actor: string, actorMeta?: EntryActorMeta | null): string {
  return resolveActorDisplay(actor, actorMeta).label
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
