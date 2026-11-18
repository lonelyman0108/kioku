import { z } from 'zod'

import { ShortId } from './links'
import { CircleKind } from './memory'

export const CIRCLE_EXPORT_FORMAT = 'kioku-circle-export'
export const CIRCLE_EXPORT_VERSION = 2

export const CIRCLE_EXPORT_MAX_BYTES = 32 * 1024 * 1024
export const CIRCLE_EXPORT_PASSPHRASE_MIN = 12
const PASSPHRASE_MAX = 1024

export const CircleExportRequest = z.object({
  passphrase: z
    .string()
    .min(CIRCLE_EXPORT_PASSPHRASE_MIN, `口令至少 ${CIRCLE_EXPORT_PASSPHRASE_MIN} 位`)
    .max(PASSPHRASE_MAX, `口令最多 ${PASSPHRASE_MAX} 位`),
})
export type CircleExportRequest = z.infer<typeof CircleExportRequest>

const ExportFile = z
  .file('请上传导出文件')
  .max(CIRCLE_EXPORT_MAX_BYTES, `文件超过 ${CIRCLE_EXPORT_MAX_BYTES / 1024 / 1024} MB 的上限`)
  .meta({ type: 'string', format: 'binary' })

const ImportPassphrase = z.string().min(1, '请填写导出时设置的口令').max(PASSPHRASE_MAX)

export const CircleImportInspectForm = z.object({ file: ExportFile, passphrase: ImportPassphrase })
export type CircleImportInspectForm = z.infer<typeof CircleImportInspectForm>

export const CircleImportForm = CircleImportInspectForm.extend({
  name: z.string().trim().max(64, '记忆圈名称最多 64 个字').optional(),
  // 个人圈包支持合并导入到当前账号的个人圈，共享圈包导入成新共享圈
  intoPersonalCircle: z.coerce.boolean().optional(),
})
export type CircleImportForm = z.infer<typeof CircleImportForm>

export const CircleImportCounts = z.object({
  personas: z.number().int(),
  clients: z.number().int(),
  facetDimensions: z.number().int(),
  facetTerms: z.number().int(),
  subjects: z.number().int(),
  linkedSubjects: z.number().int(),
  entries: z.number().int(),
  variants: z.number().int(),
  links: z.number().int(),
  secrets: z.number().int(),
  credentials: z.number().int(),
  vaultConnections: z.number().int(),
})
export type CircleImportCounts = z.infer<typeof CircleImportCounts>

const CircleExporter = z.object({ displayName: z.string(), dreamPrivate: z.boolean() })

export const CircleImportPreview = z.object({
  exporter: CircleExporter,
  circleKind: CircleKind,
  circleName: z.string(),
  circleSlug: z.string(),
  exportedAt: z.string(),
  counts: CircleImportCounts,
})
export type CircleImportPreview = z.infer<typeof CircleImportPreview>

export const RemappedShortId = z.object({ from: ShortId, to: ShortId })
export type RemappedShortId = z.infer<typeof RemappedShortId>

export const CircleImportResult = z.object({
  circleId: z.uuid(),
  circleKind: CircleKind,
  slug: z.string(),
  name: z.string(),
  exporter: CircleExporter,
  counts: CircleImportCounts,
  remappedShortIds: z.array(RemappedShortId).default([]),
})
export type CircleImportResult = z.infer<typeof CircleImportResult>
