import { z } from 'zod'

// 记忆圈类型：personal 为个人圈（每账号唯一不可删），shared 为多成员共享圈
export const CIRCLE_KINDS = ['personal', 'shared'] as const
export const CircleKind = z.enum(CIRCLE_KINDS)
export type CircleKind = z.infer<typeof CircleKind>

// 词条物种：entry 为正式词条，fact 为联系人/群事实，episode 为会话摘要
export const ENTRY_KINDS = ['entry', 'fact', 'episode'] as const
export const EntryKind = z.enum(ENTRY_KINDS)
export type EntryKind = z.infer<typeof EntryKind>

// 敏感级：按从宽到严排列，比较大小时用 sensitivityRank
export const SENSITIVITIES = ['public', 'internal', 'private', 'secret'] as const
export const Sensitivity = z.enum(SENSITIVITIES)
export type Sensitivity = z.infer<typeof Sensitivity>

export function sensitivityRank(value: Sensitivity): number {
  return SENSITIVITIES.indexOf(value)
}

export function minSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) <= sensitivityRank(b) ? a : b
}

// 写入来源：untrusted 只能写 fact 与 episode，且不参与跨作用域的自动注入与双链出链
export const PROVENANCES = ['owner', 'agent', 'untrusted', 'system'] as const
export const Provenance = z.enum(PROVENANCES)
export type Provenance = z.infer<typeof Provenance>

// 某一圈子与物种下允许的敏感级：个人圈正式词条允许设 public 供关联机器人对外回答；
// 会话摘要（episode）与未确认来源（untrusted）不设 secret
export function sensitivityAllowed(
  _circleKind: CircleKind,
  kind: EntryKind,
  sensitivity: Sensitivity,
  provenance?: Provenance,
): boolean {
  if (kind === 'episode' && sensitivity === 'secret') return false
  if (provenance === 'untrusted' && sensitivity === 'secret') return false
  return true
}

// 缺省敏感级：个人圈正式词条默认私密，共享圈默认内部
export const DEFAULT_SENSITIVITY: Record<CircleKind, Sensitivity> = {
  personal: 'private',
  shared: 'internal',
}

// 够格进启动加载（boot）的记忆判断：仅限正式词条（entry）、受信来源、非机密且优先级为 0。
// 关联个人圈作客场穿透时另需满足未标 realm 且与当前焦点无互斥冲突，见服务端 access/boot
export function bootEligible(kind: EntryKind, priority: number): boolean {
  return kind === 'entry' && priority === 0
}

export function isBootCandidate(entry: {
  kind: EntryKind
  priority: number
  provenance: Provenance
  sensitivity: Sensitivity
}): boolean {
  return (
    entry.provenance !== 'untrusted' &&
    entry.sensitivity !== 'secret' &&
    bootEligible(entry.kind, entry.priority)
  )
}

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const
export const MemberRole = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof MemberRole>

export const SUBJECT_KINDS = ['person', 'group'] as const
export const SubjectKind = z.enum(SUBJECT_KINDS)
export type SubjectKind = z.infer<typeof SubjectKind>

// 访问密钥的凭据能力：none 不可用；use 能列出凭据（不含值）、取值；manage 在此之上还能新建、修改、删除凭据。
// use 与 manage 都要求密钥最高敏感级至少为私密，manage 还要求能写对应圈子的正式词条
export const CREDENTIAL_CAPABILITIES = ['none', 'use', 'manage'] as const
export const CredentialCapability = z.enum(CREDENTIAL_CAPABILITIES)
export type CredentialCapability = z.infer<typeof CredentialCapability>

// 地层 6 色带的固定纵序：自上而下为会话摘要、联系人事实、个人圈词条、共享客场圈词条、独立人格、主场圈正式词条
export const STRATA_BANDS = [
  'episode',
  'fact',
  'personal',
  'shared-away',
  'persona',
  'primary',
] as const
export const StrataBand = z.enum(STRATA_BANDS)
export type StrataBand = z.infer<typeof StrataBand>
