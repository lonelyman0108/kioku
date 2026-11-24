import { z } from 'zod'

import { WhenCondition } from './facets'
import {
  CircleKind,
  CredentialCapability,
  ENTRY_KINDS,
  EntryKind,
  MemberRole,
  Sensitivity,
} from './memory'

export const DISPLAY_NAME_MAX = 64
export const CIRCLE_NAME_MAX = 64
export const PERSONA_MAX_DEPTH = 8
export const LINKED_CIRCLES_MAX = 32
export const ALLOWED_REALMS_MAX = 32

export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, '用户名只能包含小写字母、数字和 _.-，长度 2 到 32 位')
export const Password = z.string().min(10, '密码至少 10 位').max(256, '密码最多 256 位')
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, '只能包含小写字母、数字和连字符')

export const LoginRequest = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().max(256),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const AccountRef = z.object({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
})
export type AccountRef = z.infer<typeof AccountRef>

export const CircleSummary = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  kind: CircleKind,
  role: MemberRole,
  memberCount: z.number().int().min(1).optional(),
})
export type CircleSummary = z.infer<typeof CircleSummary>

export const MemberInfo = z.object({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: MemberRole,
})
export type MemberInfo = z.infer<typeof MemberInfo>

export const SessionUser = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  personalCircleId: z.uuid(),
  circles: z.array(CircleSummary),
  ownedSharedCircles: z.number().int(),
  maxOwnedCircles: z.number().int(),
})
export type SessionUser = z.infer<typeof SessionUser>

// 保留 Me 别名以保持接口语义一致
export const Me = SessionUser
export type Me = SessionUser

export const RUNTIME_FAMILIES = [
  'claudecode',
  'codex',
  'gemini',
  'agy',
  'openclaw',
  'hermes',
  'opencode',
  'pi',
  'dsh',
  'astrbot',
  'mcp',
  'other',
] as const
export const RuntimeFamily = z.enum(RUNTIME_FAMILIES)
export type RuntimeFamily = z.infer<typeof RuntimeFamily>

// 聊天机器人跨群识人模式：
// persona_shared：同一接入实例下非单群加锁的群之间可跨群召回个人印象并标注 [其他群印象]；
// strict：所有群严格按各自来源作用域隔离
export const PERSON_MEMORY_MODES = ['persona_shared', 'strict'] as const
export const PersonMemoryMode = z.enum(PERSON_MEMORY_MODES)
export type PersonMemoryMode = z.infer<typeof PersonMemoryMode>

export const ClientConfig = z
  .object({
    // 接入实例所有者的本人私聊提权至内部敏感级；不设时与外人私聊同级
    elevateOwnerDirect: z.literal('internal').optional(),
    // 跨群识人开关，默认 strict
    personMemoryMode: PersonMemoryMode.default('strict'),
    // 召回事件是否记录提示语前 200 字，默认 true
    recordPrompt: z.boolean().optional(),
  })
  .meta({ id: 'ClientConfig' })
export type ClientConfig = z.infer<typeof ClientConfig>

export const ClientRef = z.object({ id: z.uuid(), slug: z.string(), name: z.string() })
export type ClientRef = z.infer<typeof ClientRef>

export const ClientInfo = z
  .object({
    id: z.uuid(),
    circleId: z.uuid(),
    slug: z.string(),
    name: z.string(),
    runtimeFamily: z.string(),
    ownerAccountId: z.uuid(),
    defaultPersonaId: z.uuid().nullable(),
    config: ClientConfig,
  })
  .meta({ id: 'ClientInfo' })
export type ClientInfo = z.infer<typeof ClientInfo>

export const CreateClientRequest = z.object({
  slug: Slug,
  name: z.string().trim().min(1).max(64),
  runtimeFamily: RuntimeFamily,
  defaultPersonaId: z.uuid().nullable().default(null),
  config: ClientConfig.default({ personMemoryMode: 'strict' }),
})
export type CreateClientRequest = z.infer<typeof CreateClientRequest>

export const UpdateClientRequest = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  // 转发所有者时同步吊销该接入实例全部访问密钥
  ownerAccountId: z.uuid().optional(),
  defaultPersonaId: z.uuid().nullable().optional(),
  config: ClientConfig.optional(),
})
export type UpdateClientRequest = z.infer<typeof UpdateClientRequest>

// 按群规则：可为指定群单独切换人格，并可设单群强隔离锁（阻止该群人物事实流出，也阻止跨群印象流入）
export const ClientGroupRule = z
  .object({
    groupSubjectId: z.uuid(),
    personaId: z.uuid().nullable().default(null),
    isolateGroupMemory: z.boolean().default(false),
  })
  .refine(
    (r) => r.personaId !== null || r.isolateGroupMemory,
    '每条群规则须指定人格或开启单群隔离锁',
  )
export type ClientGroupRule = z.infer<typeof ClientGroupRule>

export const ClientGroupRules = z.object({ rules: z.array(ClientGroupRule).max(500) })
export type ClientGroupRules = z.infer<typeof ClientGroupRules>

export const ClientGroupRuleView = ClientGroupRule.extend({ groupName: z.string() })
export type ClientGroupRuleView = z.infer<typeof ClientGroupRuleView>

export const ClientGroupRuleList = z.object({ rules: z.array(ClientGroupRuleView) })
export type ClientGroupRuleList = z.infer<typeof ClientGroupRuleList>

// 独立人格及其按 trait_key 覆盖的设定段
export const TraitKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, '设定键只能包含小写字母、数字、_ 和 -')

export const PersonaTrait = z.object({
  traitKey: z.string(),
  title: z.string(),
  content: z.string(),
  sortOrder: z.number().int(),
  updatedAt: z.string(),
})
export type PersonaTrait = z.infer<typeof PersonaTrait>

export const UpsertPersonaTraitRequest = z.object({
  traitKey: TraitKey,
  title: z.string().trim().min(1, '请填写设定标题').max(120),
  content: z.string().min(1, '请填写设定正文').max(20_000),
  sortOrder: z.number().int().min(0).max(999).default(0),
})
export type UpsertPersonaTraitRequest = z.infer<typeof UpsertPersonaTraitRequest>

export const PersonaInfo = z.object({
  id: z.uuid(),
  circleId: z.uuid(),
  slug: z.string(),
  name: z.string(),
  extendsId: z.uuid().nullable(),
  description: z.string().nullable(),
  groupRuleCount: z.number().int().min(0).default(0),
})
export type PersonaInfo = z.infer<typeof PersonaInfo>

export const CreatePersonaRequest = z.object({
  slug: Slug,
  name: z.string().trim().min(1).max(64),
  extendsId: z.uuid().nullable().default(null),
  description: z.string().max(500).nullable().default(null),
  traits: z.array(UpsertPersonaTraitRequest).max(50).optional(),
})
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequest>

export const UpdatePersonaRequest = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  extendsId: z.uuid().nullable().optional(),
})
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequest>

export const ResolvedPersonaTrait = PersonaTrait.extend({
  personaId: z.uuid(),
  overriddenBy: z.string().nullable(),
})
export type ResolvedPersonaTrait = z.infer<typeof ResolvedPersonaTrait>

export const PersonaGroupRuleRef = z.object({
  clientId: z.uuid(),
  clientName: z.string(),
  groupSubjectId: z.uuid(),
  groupName: z.string(),
})
export type PersonaGroupRuleRef = z.infer<typeof PersonaGroupRuleRef>

export const PersonaDetail = PersonaInfo.extend({
  ancestors: z.array(PersonaInfo),
  children: z.array(PersonaInfo),
  ownTraits: z.array(ResolvedPersonaTrait),
  inheritedTraits: z.array(ResolvedPersonaTrait),
  clients: z.array(ClientRef),
  groupRules: z.array(PersonaGroupRuleRef).default([]),
  overrideKeyCount: z.number().int().min(0).default(0),
})
export type PersonaDetail = z.infer<typeof PersonaDetail>

// 透镜访问密钥的关联客场圈配置：read 仅只读；read_write 允许显式指定 circleId 跨圈写入
export const LINKED_CIRCLE_MODES = ['read', 'read_write'] as const
export const LinkedCircleMode = z.enum(LINKED_CIRCLE_MODES)
export type LinkedCircleMode = z.infer<typeof LinkedCircleMode>

export const LinkedCircleGrant = z.object({
  circleId: z.uuid(),
  mode: LinkedCircleMode.default('read'),
})
export type LinkedCircleGrant = z.infer<typeof LinkedCircleGrant>

// 访问密钥的静态透镜授权上限；allowedRealms 为 null 表示不按场域白名单额外收紧，
// 非 null 时目标必须非空且与之有交集（客户端上报的 project 与提问触发词不能放宽此项）
export const LensKeyScopes = z.object({
  readKinds: z.array(EntryKind).max(ENTRY_KINDS.length),
  writeKinds: z.array(EntryKind).max(ENTRY_KINDS.length),
  maxSensitivity: Sensitivity,
  allowedRealms: z
    .array(z.string().trim().toLowerCase().min(1).max(64))
    .max(ALLOWED_REALMS_MAX)
    .nullable()
    .default(null),
  admin: z.boolean(),
  credentials: CredentialCapability.default('none'),
})
export type LensKeyScopes = z.infer<typeof LensKeyScopes>

export const CreateKeyRequest = z.object({
  name: z.string().trim().min(1).max(64),
  linkedCircles: z
    .array(LinkedCircleGrant)
    .max(LINKED_CIRCLES_MAX)
    .default([])
    .refine(
      (list) => new Set(list.map((i) => i.circleId)).size === list.length,
      '关联记忆圈不能重复',
    ),
  contextFacets: WhenCondition.default({}),
  personaOverrideId: z.uuid().nullable().default(null),
  scopes: LensKeyScopes,
})
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>

export const RotateKeyRequest = z.object({
  name: z.string().trim().min(1).max(64).optional(),
})
export type RotateKeyRequest = z.infer<typeof RotateKeyRequest>

// 单个记忆圈经成员当前角色计算后的有效授权状态
export const CircleEffectiveGrant = z.object({
  circleId: z.uuid(),
  circleSlug: z.string(),
  circleName: z.string(),
  circleKind: CircleKind,
  isPrimary: z.boolean(),
  mode: LinkedCircleMode,
  readKinds: z.array(EntryKind),
  writeKinds: z.array(EntryKind),
  maxSensitivity: Sensitivity,
  credentials: CredentialCapability,
  active: z.boolean(),
})
export type CircleEffectiveGrant = z.infer<typeof CircleEffectiveGrant>

export const KeyInfo = z.object({
  id: z.uuid(),
  clientId: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  linkedCircles: z.array(LinkedCircleGrant),
  contextFacets: WhenCondition,
  personaOverrideId: z.uuid().nullable(),
  scopes: LensKeyScopes,
  // 主场圈失效或所有者离开主场圈时为 null，整个访问密钥不可用
  effectiveScopes: LensKeyScopes.nullable(),
  circleGrants: z.array(CircleEffectiveGrant),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type KeyInfo = z.infer<typeof KeyInfo>

export const IssuedKey = KeyInfo.extend({ key: z.string() })
export type IssuedKey = z.infer<typeof IssuedKey>

export const ACCESS_CONTEXTS = ['none', 'direct', 'owner_direct', 'group', 'cron'] as const
export const AccessContext = z.enum(ACCESS_CONTEXTS)
export type AccessContext = z.infer<typeof AccessContext>

export const AccessCell = z.object({
  read: z.enum(['none', 'explicit', 'recall']),
  write: z.boolean(),
})
export type AccessCell = z.infer<typeof AccessCell>

export const CircleAccessMatrixRow = z.object({
  kind: EntryKind,
  cells: z.array(AccessCell.extend({ sensitivity: Sensitivity })),
})
export type CircleAccessMatrixRow = z.infer<typeof CircleAccessMatrixRow>

export const CircleAccessMatrix = z.object({
  circleId: z.uuid(),
  circleName: z.string(),
  circleKind: CircleKind,
  isPrimary: z.boolean(),
  rows: z.array(CircleAccessMatrixRow),
  credentials: CredentialCapability,
})
export type CircleAccessMatrix = z.infer<typeof CircleAccessMatrix>

export const KeyAccessMatrix = z.object({
  contexts: z.array(
    z.object({
      context: AccessContext,
      circles: z.array(CircleAccessMatrix),
      originScope: z.enum(['any', 'client', 'group', 'direct']),
      credentials: CredentialCapability,
    }),
  ),
})
export type KeyAccessMatrix = z.infer<typeof KeyAccessMatrix>

export const WhoAmIVocabularyDimension = z.object({
  key: z.string(),
  name: z.string(),
  matchMode: z.enum(['exclusive', 'additive']),
  terms: z.array(z.object({ slug: z.string(), label: z.string() })),
})

export const WhoAmI = z
  .object({
    primaryCircle: z.object({ id: z.uuid(), slug: z.string(), name: z.string(), kind: CircleKind }),
    linkedCircles: z.array(
      z.object({
        id: z.uuid(),
        slug: z.string().nullable(),
        name: z.string().nullable(),
        kind: CircleKind,
        mode: LinkedCircleMode,
      }),
    ),
    accountName: z.string().max(DISPLAY_NAME_MAX).optional(),
    client: ClientInfo,
    persona: z.object({ id: z.uuid(), slug: z.string(), name: z.string() }).nullable(),
    contextFacets: WhenCondition,
    resolvedFacets: WhenCondition,
    vocabulary: z.array(WhoAmIVocabularyDimension),
    scopes: LensKeyScopes,
  })
  .meta({ id: 'WhoAmI' })
export type WhoAmI = z.infer<typeof WhoAmI>

export const ErrorResponse = z.object({ error: z.string() }).meta({ id: 'ErrorResponse' })
export type ErrorResponse = z.infer<typeof ErrorResponse>
