import { z } from 'zod'

import { AllowedRealms } from './auth'
import {
  CREDENTIAL_FIELD_PATTERN,
  CREDENTIAL_PLACEHOLDER_PREFIX,
  CREDENTIAL_SLUG_PATTERN,
  CREDENTIAL_SLUG_RE,
  ShortId,
} from './links'

export { CREDENTIAL_PLACEHOLDER_PREFIX, CREDENTIAL_SLUG_PATTERN, CREDENTIAL_SLUG_RE }

export const CREDENTIAL_KINDS = ['secret', 'login', 'api', 'database', 'ssh'] as const
export const CredentialKind = z.enum(CREDENTIAL_KINDS).meta({ id: 'CredentialKind' })
export type CredentialKind = z.infer<typeof CredentialKind>

export const CREDENTIAL_PROVIDERS = ['builtin', 'bitwarden', '1password'] as const
export const CredentialProvider = z.enum(CREDENTIAL_PROVIDERS).meta({ id: 'CredentialProvider' })
export type CredentialProvider = z.infer<typeof CredentialProvider>

export const CREDENTIAL_LABEL_MAX = 64
export const CREDENTIAL_FIELD_LABEL_MAX = 64
export const CREDENTIAL_DESCRIPTION_MAX = 500
export const CREDENTIAL_VALUE_MAX = 16_384
export const CREDENTIAL_FIELDS_MAX = 32
export const CREDENTIAL_RESOLVE_MAX = 32
export const CREDENTIAL_PURPOSE_MAX = 200
export const CREDENTIAL_EXTERNAL_REF_MAX = 512

export const CredentialSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    CREDENTIAL_SLUG_PATTERN,
    '标识只能包含小写字母、数字和 ._-，须以字母或数字开头，最长 64 个字符',
  )

export const CredentialFieldName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    CREDENTIAL_FIELD_PATTERN,
    '字段名只能包含小写字母、数字、_ 和 -，须以字母或数字开头，最长 64 个字符',
  )

export const CredentialLabel = z
  .string()
  .trim()
  .min(1, '名称不能为空')
  .max(CREDENTIAL_LABEL_MAX, `名称最多 ${CREDENTIAL_LABEL_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '名称不能含控制字符')

export const CredentialFieldLabel = z
  .string()
  .trim()
  .min(1, '字段显示名不能为空')
  .max(CREDENTIAL_FIELD_LABEL_MAX, `字段显示名最多 ${CREDENTIAL_FIELD_LABEL_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '字段显示名不能含控制字符')

export const CredentialDescription = z
  .string()
  .trim()
  .max(CREDENTIAL_DESCRIPTION_MAX, `说明最多 ${CREDENTIAL_DESCRIPTION_MAX} 个字符`)

export const CredentialSecretValue = z
  .string()
  .min(1, '凭据值不能为空')
  .max(CREDENTIAL_VALUE_MAX, `凭据值最多 ${CREDENTIAL_VALUE_MAX} 个字符`)

export const CredentialFieldMeta = z.object({
  name: CredentialFieldName,
  label: CredentialFieldLabel.optional(),
  secret: z.boolean().default(true),
  multiline: z.boolean().optional(),
})
export type CredentialFieldMeta = z.infer<typeof CredentialFieldMeta>

export const CredentialFieldMetaList = z
  .array(CredentialFieldMeta)
  .max(CREDENTIAL_FIELDS_MAX, `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`)
  .refine(
    (items) => new Set(items.map((item) => item.name)).size === items.length,
    '字段名不能重复',
  )

export const CredentialExtraFields = z
  .record(CredentialFieldName, CredentialSecretValue)
  .refine(
    (obj) => Object.keys(obj).length <= CREDENTIAL_FIELDS_MAX,
    `附加字段最多 ${CREDENTIAL_FIELDS_MAX} 个`,
  )

export interface CredentialTemplateDefinition {
  kind: CredentialKind
  label: string
  defaultPrimaryField: string
  fields: readonly CredentialFieldMeta[]
}

export const DEFAULT_PRIMARY_FIELD_BY_KIND: Readonly<Record<CredentialKind, string>> = {
  secret: 'value',
  login: 'password',
  api: 'token',
  database: 'url',
  ssh: 'private_key',
}

export const CREDENTIAL_TEMPLATES: Readonly<Record<CredentialKind, CredentialTemplateDefinition>> =
  {
    secret: {
      kind: 'secret',
      label: '通用密文',
      defaultPrimaryField: 'value',
      fields: [{ name: 'value', label: '值', secret: true }],
    },
    login: {
      kind: 'login',
      label: '账号与密码',
      defaultPrimaryField: 'password',
      fields: [
        { name: 'url', label: '登录地址', secret: false },
        { name: 'username', label: '用户名', secret: false },
        { name: 'password', label: '密码', secret: true },
        { name: 'recovery_codes', label: '恢复码', secret: true, multiline: true },
      ],
    },
    api: {
      kind: 'api',
      label: 'API / 服务凭据',
      defaultPrimaryField: 'token',
      fields: [
        { name: 'endpoint', label: '接口地址', secret: false },
        { name: 'token', label: '访问令牌', secret: true },
        { name: 'api_secret', label: '密钥', secret: true },
      ],
    },
    database: {
      kind: 'database',
      label: '数据库连接',
      defaultPrimaryField: 'url',
      fields: [
        { name: 'url', label: '连接串', secret: true },
        { name: 'host', label: '主机', secret: false },
        { name: 'port', label: '端口', secret: false },
        { name: 'database', label: '数据库名', secret: false },
        { name: 'username', label: '用户名', secret: false },
        { name: 'password', label: '密码', secret: true },
      ],
    },
    ssh: {
      kind: 'ssh',
      label: 'SSH / 密钥对',
      defaultPrimaryField: 'private_key',
      fields: [
        { name: 'host', label: '主机', secret: false },
        { name: 'username', label: '用户名', secret: false },
        { name: 'public_key', label: '公钥', secret: false, multiline: true },
        { name: 'private_key', label: '私钥', secret: true, multiline: true },
        { name: 'passphrase', label: '私钥口令', secret: true },
      ],
    },
  }

export function getCredentialTemplate(kind: CredentialKind): CredentialTemplateDefinition {
  return CREDENTIAL_TEMPLATES[kind]
}

export function defaultPrimaryFieldForKind(kind: CredentialKind): string {
  return DEFAULT_PRIMARY_FIELD_BY_KIND[kind]
}

export function defaultFieldMetaForKind(kind: CredentialKind): CredentialFieldMeta[] {
  return CREDENTIAL_TEMPLATES[kind].fields.map((field) => ({ ...field }))
}

export const CredentialMeta = z
  .object({
    id: z.uuid(),
    slug: CredentialSlug,
    label: z.string(),
    description: z.string().nullable(),
    kind: CredentialKind,
    primaryField: CredentialFieldName,
    fieldMeta: z.array(CredentialFieldMeta),
    passkeyManualOnly: z.boolean(),
    provider: CredentialProvider,
    externalRef: z.string().nullable(),
    allowedRealms: z.array(z.string()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'CredentialMeta' })
export type CredentialMeta = z.infer<typeof CredentialMeta>

export const CredentialListResponse = z.object({
  items: z.array(CredentialMeta),
})
export type CredentialListResponse = z.infer<typeof CredentialListResponse>

export const CreateCredentialRequest = z
  .object({
    slug: CredentialSlug,
    label: CredentialLabel,
    description: CredentialDescription.nullable().optional(),
    kind: CredentialKind.optional(),
    primaryField: CredentialFieldName.optional(),
    fieldMeta: CredentialFieldMetaList.optional(),
    value: CredentialSecretValue.optional(),
    fields: CredentialExtraFields.optional(),
    passkeyManualOnly: z.boolean().optional(),
    allowedRealms: AllowedRealms.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    const hasValue = val.value !== undefined
    const hasFields = val.fields !== undefined && Object.keys(val.fields).length > 0
    if (!hasValue && !hasFields) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: '请至少填写一个凭据字段值',
      })
    }
    const kind = val.kind ?? 'secret'
    const mergedCount = new Set([
      ...(hasValue ? [val.primaryField ?? defaultPrimaryFieldForKind(kind)] : []),
      ...Object.keys(val.fields ?? {}),
    ]).size
    if (mergedCount > CREDENTIAL_FIELDS_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: `字段最多 ${CREDENTIAL_FIELDS_MAX} 个`,
      })
    }
  })
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

export const UpdateCredentialRequest = z.object({
  label: CredentialLabel.optional(),
  description: CredentialDescription.nullable().optional(),
  kind: CredentialKind.optional(),
  primaryField: CredentialFieldName.optional(),
  fieldMeta: CredentialFieldMetaList.optional(),
  value: CredentialSecretValue.optional(),
  fields: CredentialExtraFields.nullable().optional(),
  removeFields: z.array(CredentialFieldName).max(CREDENTIAL_FIELDS_MAX).optional(),
  passkeyManualOnly: z.boolean().optional(),
  allowedRealms: AllowedRealms.nullable().optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

export const REVEAL_CREDENTIAL_SCOPES = ['plain', 'all'] as const
export const RevealCredentialScope = z.enum(REVEAL_CREDENTIAL_SCOPES)
export type RevealCredentialScope = z.infer<typeof RevealCredentialScope>

export const RevealCredentialRequest = z
  .strictObject({
    scope: RevealCredentialScope.optional(),
    field: CredentialFieldName.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.scope !== undefined && val.field !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['field'],
        message: 'scope 与 field 不能同时指定',
      })
    }
  })
export type RevealCredentialRequest = z.infer<typeof RevealCredentialRequest>

export const RevealCredentialResponse = z
  .object({
    value: z.string().optional(),
    field: z.string().optional(),
    fields: z.record(z.string(), z.string()).optional(),
  })
  .refine(
    (res) => res.value !== undefined || res.fields !== undefined,
    '解密响应至少包含 value 或 fields',
  )
export type RevealCredentialResponse = z.infer<typeof RevealCredentialResponse>

export const CredentialReferenceItem = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  realms: z.array(z.string()),
  updatedAt: z.string(),
  fields: z.array(z.string().nullable()),
})
export type CredentialReferenceItem = z.infer<typeof CredentialReferenceItem>

export const CredentialReferencesResponse = z.object({
  items: z.array(CredentialReferenceItem),
})
export type CredentialReferencesResponse = z.infer<typeof CredentialReferencesResponse>

// 供 kioku run 一次性原子取值；field 可省以同时兼容 slug 与 slug#field 两种写法
export const ResolveCredentialRef = z.object({
  identifier: CredentialSlug,
  field: CredentialFieldName.optional(),
})
export type ResolveCredentialRef = z.infer<typeof ResolveCredentialRef>

export const ResolveCredentialsRequest = z.object({
  refs: z
    .array(ResolveCredentialRef)
    .min(1, '至少请求一条凭据')
    .max(CREDENTIAL_RESOLVE_MAX, `一次最多 ${CREDENTIAL_RESOLVE_MAX} 项`)
    .refine(
      (refs) => new Set(refs.map((r) => `${r.identifier}#${r.field ?? ''}`)).size === refs.length,
      '同一个标识与字段不能重复',
    ),
  purpose: z.string().trim().max(CREDENTIAL_PURPOSE_MAX).optional(),
})
export type ResolveCredentialsRequest = z.infer<typeof ResolveCredentialsRequest>

export const ResolvedCredentialValue = z.object({
  identifier: z.string(),
  field: z.string(),
  value: z.string(),
})
export type ResolvedCredentialValue = z.infer<typeof ResolvedCredentialValue>

export const ResolvedCredentialExpired = z.object({
  identifier: z.string(),
  expiresAt: z.string(),
})
export type ResolvedCredentialExpired = z.infer<typeof ResolvedCredentialExpired>

export const ResolveCredentialsResponse = z.object({
  values: z.array(ResolvedCredentialValue),
  expired: z.array(ResolvedCredentialExpired),
})
export type ResolveCredentialsResponse = z.infer<typeof ResolveCredentialsResponse>
export const ResolvedCredentials = ResolveCredentialsResponse
export type ResolvedCredentials = ResolveCredentialsResponse
