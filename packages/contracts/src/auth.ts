import { z } from 'zod'

import { normalizeSlugList, SceneSlug, SceneSlugList } from './entries'

export const DISPLAY_NAME_MAX = 64
export const KEY_NAME_MAX = 64
export const ALLOWED_REALMS_MAX = 32

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, '用户名只能包含小写字母、数字和 _.-，长度 2 到 32 位')

export const Password = z.string().min(10, '密码至少 10 位').max(256, '密码最多 256 位')

export const DisplayName = z
  .string()
  .trim()
  .min(1, '请填写显示名')
  .max(DISPLAY_NAME_MAX, `显示名不超过 ${DISPLAY_NAME_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '显示名不能含控制字符')

export const KeyName = z
  .string()
  .trim()
  .min(1, '请填写密钥名称')
  .max(KEY_NAME_MAX, `密钥名称不超过 ${KEY_NAME_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '密钥名称不能含控制字符')

export const RUNTIME_FAMILIES = [
  'claudecode',
  'codex',
  'gemini',
  'agy',
  'opencode',
  'pi',
  'dsh',
  'openclaw',
  'hermes',
  'mcp',
  'generic',
] as const
export const RuntimeFamily = z.enum(RUNTIME_FAMILIES).meta({ id: 'RuntimeFamily' })
export type RuntimeFamily = z.infer<typeof RuntimeFamily>

// 兼容旧版客户端可能传入的 other，归一到 generic
export const CompatRuntimeFamily = z.preprocess(
  (v) => (v === 'other' ? 'generic' : v),
  RuntimeFamily,
)

export const LoginRequest = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().max(256),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1, '请填写当前密码').max(256),
  newPassword: Password,
})
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>

export const UpdateProfileRequest = z.object({
  displayName: DisplayName,
})
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>

export const MeResponse = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  hasMasterKey: z.boolean(),
  hasEmbeddingModel: z.boolean(),
  hasChatModel: z.boolean(),
  version: z.string(),
})
export type MeResponse = z.infer<typeof MeResponse>
export const Me = MeResponse
export type Me = MeResponse

export const SessionItem = z.object({
  id: z.uuid(),
  clientAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastActiveAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
})
export type SessionItem = z.infer<typeof SessionItem>

export const SessionsResponse = z.object({
  items: z.array(SessionItem),
})
export type SessionsResponse = z.infer<typeof SessionsResponse>

export const AllowedRealms = z
  .array(SceneSlug)
  .max(ALLOWED_REALMS_MAX, `允许场域最多 ${ALLOWED_REALMS_MAX} 项`)
  .transform((list) => normalizeSlugList(list))

export const ApiKeyView = z
  .object({
    id: z.uuid(),
    name: z.string(),
    runtimeFamily: RuntimeFamily,
    prefix: z.string(),
    envs: z.array(z.string()),
    allowedRealms: z.array(z.string()).nullable(),
    focusRealms: z.array(z.string()).nullable().optional(),
    canWrite: z.boolean(),
    canResolveCredentials: z.boolean(),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .meta({ id: 'ApiKeyView' })
export type ApiKeyView = z.infer<typeof ApiKeyView>

export const ApiKeyListResponse = z.object({
  items: z.array(ApiKeyView),
})
export type ApiKeyListResponse = z.infer<typeof ApiKeyListResponse>

export const CreateApiKeyRequest = z.object({
  name: KeyName,
  runtimeFamily: CompatRuntimeFamily.default('generic'),
  envs: SceneSlugList.default([]),
  allowedRealms: AllowedRealms.nullable().default(null),
  focusRealms: AllowedRealms.nullable().optional(),
  canWrite: z.boolean().default(true),
  canResolveCredentials: z.boolean().default(false),
})
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>

export const UpdateApiKeyRequest = z.object({
  name: KeyName.optional(),
  runtimeFamily: CompatRuntimeFamily.optional(),
  envs: SceneSlugList.optional(),
  allowedRealms: AllowedRealms.nullable().optional(),
  focusRealms: AllowedRealms.nullable().optional(),
  canWrite: z.boolean().optional(),
  canResolveCredentials: z.boolean().optional(),
})
export type UpdateApiKeyRequest = z.infer<typeof UpdateApiKeyRequest>

export const RotateApiKeyRequest = z.object({
  name: KeyName.optional(),
})
export type RotateApiKeyRequest = z.infer<typeof RotateApiKeyRequest>

export const IssuedApiKeyResponse = z.object({
  key: z.string(),
  item: ApiKeyView,
})
export type IssuedApiKeyResponse = z.infer<typeof IssuedApiKeyResponse>

export const WhoAmIClient = z.object({
  slug: z.string(),
  name: z.string(),
  runtimeFamily: RuntimeFamily,
})
export type WhoAmIClient = z.infer<typeof WhoAmIClient>

export const WhoAmIKey = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  runtimeFamily: RuntimeFamily,
  envs: z.array(z.string()),
  allowedRealms: z.array(z.string()).nullable(),
  focusRealms: z.array(z.string()).nullable().optional(),
  canWrite: z.boolean(),
  canResolveCredentials: z.boolean(),
})
export type WhoAmIKey = z.infer<typeof WhoAmIKey>

// 可选保留 primaryCircle 兼容字段，供旧版命令行诊断平滑读取
export const WhoAmIResponse = z.object({
  accountName: z.string(),
  key: WhoAmIKey,
  client: WhoAmIClient,
  primaryCircle: z
    .object({
      slug: z.string(),
      name: z.string(),
      kind: z.literal('personal'),
    })
    .optional(),
})
export type WhoAmIResponse = z.infer<typeof WhoAmIResponse>
