import {
  DREAM_KIND_NAMES,
  type BootBucket,
  type BootExcludeReason,
  type BootMode,
  type BootOmitReason,
  type DreamMode,
  type DreamOutcome,
  type DreamSuggestionKind,
  type DreamTrigger,
  type EntryActorKind,
  type EntryActorMeta,
  type EntryEventType,
  type EntryKind,
  type EntryTab,
  type HygieneSweepFixKind,
  type ReasoningEffort,
} from '@kioku/contracts'

import { icons } from './icons'
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

export const entryTabIcons: Record<EntryTab, string> = {
  all: icons.layers,
  pinned: icons.pin,
  regular: icons.bookOpen,
  episodes: icons.messageSquare,
  trash: icons.remove,
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

export const eventTypeIcons: Record<EntryEventType, string> = {
  create: icons.add,
  update: icons.edit,
  delete: icons.remove,
  undelete: icons.undelete,
  restore: icons.restore,
  archive_note: icons.history,
}

export const entryFieldLabels: Record<string, string> = {
  title: '标题',
  summary: '现行概要',
  content: '正文',
  disclosure: '触发场景',
  isPinned: '常驻',
  bootMode: '启动加载',
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

export const hygieneFixIcons: Record<HygieneSweepFixKind, string> = {
  strip_duplicate_heading: icons.split,
  strip_legacy_glossary: icons.eraser,
  rewrite_legacy_links: icons.linkChain,
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

export const dreamKindIcons: Record<DreamSuggestionKind, string> = {
  adjust_boot_mode: icons.pin,
  link_entries: icons.links,
  merge_duplicates: icons.merge,
  tidy: icons.tidy,
  distill_episode: icons.promote,
  update: icons.updateDoc,
  mark_stale: icons.stale,
}

export const dreamModeLabels: Record<DreamMode, string> = {
  standard: '增量整理',
  cross_memory: '查重/关联',
  tidy: '规范整理',
}

export const dreamTriggerLabels: Record<DreamTrigger, string> = {
  scheduled: '定时整理',
  manual: '手动整理',
}

export const dreamOutcomeLabels: Record<DreamOutcome, string> = {
  ok: '完成',
  partial: '部分完成',
  skipped: '跳过',
  failed: '失败',
}

export const reasoningEffortLabels: Record<ReasoningEffort, string> = {
  default: '跟随默认',
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极限',
}

export const reasoningEffortWireValues: Record<ReasoningEffort, string | null> = {
  default: null,
  off: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

export const reasoningEffortDescriptions: Record<ReasoningEffort, string> = {
  default: '不向接口注入 reasoning_effort 参数，沿用服务端默认策略，兼容非推理模型',
  off: '关闭思考链（发送 reasoning_effort: "none"），响应最快，适合随手记与会话摘要',
  minimal: '极少量思考（发送 reasoning_effort: "minimal"），仅做最基础校验',
  low: '轻量思考（发送 reasoning_effort: "low"），平衡响应速度与准确度',
  medium: '中等思考（发送 reasoning_effort: "medium"），适合日常增量与规范整理',
  high: '深度思考（发送 reasoning_effort: "high"），适合跨记忆查重合并与复杂规范',
  xhigh: '超高深度思考（发送 reasoning_effort: "xhigh"），供支持超高档位的推理模型使用',
  max: '最高推理预算（发送 reasoning_effort: "max"），耗时与开销最高，建议仅在深度整理时按需选用',
}

export const bootModeLabels: Record<BootMode, string> = {
  none: '按需召回',
  index: '目录常驻',
  full: '全文常驻',
}

export const bootModeIcons: Record<BootMode, string> = {
  none: icons.bookOpen,
  index: icons.bookmark,
  full: icons.pin,
}

export const bootModeDescriptions: Record<BootMode, string> = {
  none: '仅在检索或提及相关主题时按需召回',
  index: '会话启动仅注入标题、概要与字数索引，适合长篇参考手册',
  full: '会话启动直接展开全文，适合简短跨会话规则（建议 1,200 字内）',
}

export const bootBucketLabels: Record<BootBucket, string> = {
  exact: '当前场景精准命中',
  context: '环境与场域匹配',
  global: '全局通用',
}

export const bootBucketIcons: Record<BootBucket, string> = {
  exact: icons.targetExact,
  context: icons.layers,
  global: icons.globe,
}

export const bootOmitReasonLabels: Record<BootOmitReason, string> = {
  index: '目录常驻',
  oversized: '超单条上限降级',
  budget: '超预算降级',
}

export const bootOmitReasonIcons: Record<BootOmitReason, string> = {
  index: icons.bookmark,
  oversized: icons.warning,
  budget: icons.gauge,
}

export const bootExcludeReasonLabels: Record<BootExcludeReason, string> = {
  realm_forbidden: '超出允许场域',
  scene_conflict: '场景不匹配',
  project_mismatch: '非当前项目',
  expired: '已过期',
}

export const bootExcludeReasonIcons: Record<BootExcludeReason, string> = {
  realm_forbidden: icons.lock,
  scene_conflict: icons.filterX,
  project_mismatch: icons.folderX,
  expired: icons.clock,
}
