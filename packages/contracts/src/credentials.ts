import { z } from 'zod'

import { AllowedRealms } from './auth'
import {
  CREDENTIAL_FIELD_PATTERN,
  CREDENTIAL_PLACEHOLDER_PREFIX,
  CREDENTIAL_SLUG_PATTERN,
  CREDENTIAL_SLUG_RE,
} from './links'

export { CREDENTIAL_PLACEHOLDER_PREFIX, CREDENTIAL_SLUG_PATTERN, CREDENTIAL_SLUG_RE }

export const CREDENTIAL_LABEL_MAX = 64
export const CREDENTIAL_DESCRIPTION_MAX = 500
export const CREDENTIAL_VALUE_MAX = 16_384
export const CREDENTIAL_FIELDS_MAX = 32
export const CREDENTIAL_RESOLVE_MAX = 32
export const CREDENTIAL_PURPOSE_MAX = 200

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

export const CredentialDescription = z
  .string()
  .trim()
  .max(CREDENTIAL_DESCRIPTION_MAX, `说明最多 ${CREDENTIAL_DESCRIPTION_MAX} 个字符`)

export const CredentialSecretValue = z
  .string()
  .min(1, '凭据值不能为空')
  .max(CREDENTIAL_VALUE_MAX, `凭据值最多 ${CREDENTIAL_VALUE_MAX} 个字符`)

export const CredentialExtraFields = z
  .record(CredentialFieldName, CredentialSecretValue)
  .refine(
    (obj) => Object.keys(obj).length <= CREDENTIAL_FIELDS_MAX,
    `附加字段最多 ${CREDENTIAL_FIELDS_MAX} 个`,
  )

export const CredentialMeta = z
  .object({
    id: z.uuid(),
    slug: CredentialSlug,
    label: z.string(),
    description: z.string().nullable(),
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

export const CreateCredentialRequest = z.object({
  slug: CredentialSlug,
  label: CredentialLabel,
  description: CredentialDescription.nullable().optional(),
  value: CredentialSecretValue,
  fields: CredentialExtraFields.optional(),
  allowedRealms: AllowedRealms.nullable().optional(),
})
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>

export const UpdateCredentialRequest = z.object({
  label: CredentialLabel.optional(),
  description: CredentialDescription.nullable().optional(),
  value: CredentialSecretValue.optional(),
  fields: CredentialExtraFields.nullable().optional(),
  allowedRealms: AllowedRealms.nullable().optional(),
})
export type UpdateCredentialRequest = z.infer<typeof UpdateCredentialRequest>

export const RevealCredentialResponse = z.object({
  value: z.string(),
  fields: z.record(z.string(), z.string()).optional(),
})
export type RevealCredentialResponse = z.infer<typeof RevealCredentialResponse>

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
