import { z } from 'zod'

import { KeyScopes, MemberRole } from './memory'

export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, '用户名只用小写字母、数字和 _.-，2 到 32 位')
export const Password = z.string().min(10, '密码至少 10 位').max(256)
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, '只用小写字母、数字和连字符')

export const SetupStatus = z.object({ needsSetup: z.boolean() })
export type SetupStatus = z.infer<typeof SetupStatus>

export const SetupRequest = z.object({
  username: Username,
  displayName: z.string().min(1).max(64),
  password: Password,
  spaceName: z.string().min(1).max(64),
})
export type SetupRequest = z.infer<typeof SetupRequest>

export const LoginRequest = z.object({ username: z.string(), password: z.string() })
export type LoginRequest = z.infer<typeof LoginRequest>

export const SpaceSummary = z.object({ id: z.uuid(), name: z.string(), role: MemberRole })
export type SpaceSummary = z.infer<typeof SpaceSummary>

export const Me = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  spaces: z.array(SpaceSummary),
})
export type Me = z.infer<typeof Me>

export const RUNTIME_FAMILIES = [
  'claudecode',
  'codex',
  'openclaw',
  'hermes',
  'opencode',
  'pi',
  'astrbot',
  'mcp',
  'other',
] as const
export const RuntimeFamily = z.enum(RUNTIME_FAMILIES)
export type RuntimeFamily = z.infer<typeof RuntimeFamily>

export const AppConfig = z.object({
  elevateOwnerDirect: z.literal('internal').optional(),
})
export type AppConfig = z.infer<typeof AppConfig>

export const CreateAppRequest = z.object({
  slug: Slug,
  name: z.string().min(1).max(64),
  runtimeFamily: RuntimeFamily,
  config: AppConfig.default({}),
})
export type CreateAppRequest = z.infer<typeof CreateAppRequest>

export const AppInfo = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  runtimeFamily: z.string(),
  ownerAccountId: z.uuid(),
  config: AppConfig,
})
export type AppInfo = z.infer<typeof AppInfo>

export const CreateKeyRequest = z.object({
  name: z.string().min(1).max(64),
  scopes: KeyScopes,
})
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>

export const KeyInfo = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: KeyScopes,
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type KeyInfo = z.infer<typeof KeyInfo>

// 只在创建时返回一次明文
export const CreatedKey = KeyInfo.extend({ key: z.string() })
export type CreatedKey = z.infer<typeof CreatedKey>

export const WhoAmI = z.object({
  spaceId: z.uuid(),
  app: AppInfo,
  scopes: KeyScopes,
})
export type WhoAmI = z.infer<typeof WhoAmI>

export const ErrorResponse = z.object({ error: z.string() })
export type ErrorResponse = z.infer<typeof ErrorResponse>
