import {
  CIRCLE_EXPORT_FORMAT,
  CIRCLE_EXPORT_VERSION,
  CircleKind,
  ClientConfig,
  CredentialField,
  CredentialSource,
  EntryKind,
  FacetMatchMode,
  Provenance,
  Sensitivity,
  ShortId,
  SubjectKind,
  VaultConnectionStatus,
  VaultDisabledReason,
  VaultErrorKind,
  WhenCondition,
} from '@kioku/contracts'
import { z } from 'zod'

export { CIRCLE_EXPORT_FORMAT, CIRCLE_EXPORT_VERSION }
export const CIRCLE_EXPORT_MAX_PLAIN_BYTES = 128 * 1024 * 1024

// PostgreSQL text 不能存 NUL 与不成对的代理字符
function storable(text: string): boolean {
  if (text.includes('\0')) return false
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (next < 0xdc00 || next > 0xdfff) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

const UNSTORABLE = '包含数据库无法存放的字符'
export const Text = z.string().refine(storable, UNSTORABLE)

export const Time = z.iso.datetime({ offset: true }).refine((value) => {
  const parsed = Date.parse(value)
  return !Number.isNaN(parsed)
}, '时间格式不对')

export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return '字段格式不正确'
  const path = issue.path.length ? `${issue.path.join('.')} ` : ''
  return `${path}${issue.message}`
}

export const CircleExportHeader = z.object({
  type: z.literal('header'),
  format: z.literal(CIRCLE_EXPORT_FORMAT),
  version: z.literal(CIRCLE_EXPORT_VERSION),
  exportedAt: Time,
  circle: z.object({
    kind: CircleKind,
    slug: Text,
    name: Text,
    defaultFacets: WhenCondition.default({}),
  }),
  exporter: z.object({
    displayName: Text,
    dreamPrivate: z.boolean(),
  }),
})

export const PersonaRecord = z.object({
  type: z.literal('persona'),
  slug: Text,
  name: Text,
  description: Text.nullable(),
  extendsSlug: Text.nullable(),
  traits: z
    .array(
      z.object({
        traitKey: Text,
        title: Text,
        content: Text,
        sortOrder: z.number().int(),
      }),
    )
    .default([]),
})

export const ClientRecord = z.object({
  type: z.literal('client'),
  slug: Text,
  name: Text,
  runtimeFamily: Text,
  defaultPersonaSlug: Text.nullable(),
  config: ClientConfig,
  groupRules: z
    .array(
      z.object({
        groupPlatform: Text,
        groupExternalId: Text,
        groupName: Text.nullable(),
        personaSlug: Text.nullable(),
        isolateGroupMemory: z.boolean(),
      }),
    )
    .default([]),
})

export const FacetDimensionRecord = z.object({
  type: z.literal('facet_dimension'),
  key: Text,
  name: Text,
  matchMode: FacetMatchMode,
  description: Text.nullable(),
})

export const FacetTermRecord = z.object({
  type: z.literal('facet_term'),
  dimensionKey: Text,
  slug: Text,
  label: Text,
  implies: WhenCondition.default({}),
  aliases: z.array(Text).default([]),
  autoRegistered: z.boolean().default(false),
})

export const SubjectRecord = z.object({
  type: z.literal('subject'),
  key: Text,
  kind: SubjectKind,
  displayName: Text,
  nameLocked: z.boolean().default(false),
})

export const IdentityRecord = z.object({
  type: z.literal('identity'),
  subjectKey: Text,
  kind: SubjectKind,
  platform: Text,
  externalId: Text,
  displayName: Text.nullable(),
})

export const VaultConnectionRecord = z.object({
  type: z.literal('vault_connection'),
  key: Text,
  serverUrl: Text,
  email: Text,
  vaultUserId: Text,
  deviceId: z.uuid(),
  status: VaultConnectionStatus,
  disabledReason: VaultDisabledReason.nullable(),
  lastErrorKind: VaultErrorKind.nullable(),
  lastErrorAt: Time.nullable(),
  lastCheckedAt: Time.nullable(),
  disconnectedAt: Time.nullable(),
  defaultOrganizationId: Text.nullable(),
  defaultCollectionId: Text.nullable(),
  defaultCollectionName: Text.nullable(),
})

export const CredentialRecord = z.object({
  type: z.literal('credential'),
  identifier: Text,
  name: Text,
  description: Text.nullable(),
  source: CredentialSource,
  fields: z.array(CredentialField),
  values: z.record(Text, Text).nullable(),
  vaultConnectionKey: Text.nullable(),
  vaultItemId: Text.nullable(),
  vaultRevision: Text.nullable(),
  clientSlugs: z.array(Text).nullable(),
  allowedRealms: z.array(Text).nullable(),
  expiresAt: Time.nullable(),
  rotationRequestedAt: Time.nullable(),
  valueVersion: z.number().int(),
  valueChangedAt: Time.nullable(),
})

export const VariantExportItem = z.object({
  when: WhenCondition.default({}),
  sortOrder: z.number().int().default(0),
  content: Text,
  createdAt: Time.optional(),
  updatedAt: Time.optional(),
})

export const EntryRecord = z.object({
  type: z.literal('entry'),
  shortId: ShortId,
  kind: EntryKind,
  originScope: Text,
  subjectKey: Text.nullable(),
  clientSlug: Text.nullable(),
  title: Text,
  sensitivity: Sensitivity,
  provenance: Provenance,
  priority: z.number().int(),
  disclosure: Text.nullable(),
  topics: z.array(Text).default([]),
  realms: z.array(Text).default([]),
  glossary: z.array(Text).default([]),
  legacyUris: z.array(z.object({ legacyUri: Text, source: Text })).default([]),
  validFrom: Time,
  validTo: Time.nullable(),
  expiresAt: Time.nullable(),
  variants: z.array(VariantExportItem).min(1),
  createdAt: Time,
  updatedAt: Time,
})

export const EntryLinkRecord = z.object({
  type: z.literal('link'),
  sourceShortId: ShortId,
  sourceWhen: WhenCondition.default({}),
  targetShortId: ShortId,
})

export const CircleExportRecord = z.discriminatedUnion('type', [
  CircleExportHeader,
  PersonaRecord,
  ClientRecord,
  FacetDimensionRecord,
  FacetTermRecord,
  SubjectRecord,
  IdentityRecord,
  VaultConnectionRecord,
  CredentialRecord,
  EntryRecord,
  EntryLinkRecord,
])

export type CircleExportHeader = z.infer<typeof CircleExportHeader>
export type PersonaRecord = z.infer<typeof PersonaRecord>
export type ClientRecord = z.infer<typeof ClientRecord>
export type FacetDimensionRecord = z.infer<typeof FacetDimensionRecord>
export type FacetTermRecord = z.infer<typeof FacetTermRecord>
export type SubjectRecord = z.infer<typeof SubjectRecord>
export type IdentityRecord = z.infer<typeof IdentityRecord>
export type VaultConnectionRecord = z.infer<typeof VaultConnectionRecord>
export type CredentialRecord = z.infer<typeof CredentialRecord>
export type EntryRecord = z.infer<typeof EntryRecord>
export type EntryLinkRecord = z.infer<typeof EntryLinkRecord>
export type CircleExportRecord = z.infer<typeof CircleExportRecord>
