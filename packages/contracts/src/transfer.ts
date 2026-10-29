import { z } from 'zod'

// 按空间导出与导入：空间 owner 把一个空间导出成用口令加密的文件，实例管理员把它导入成另一个实例里的新空间。
// 口令由导出人设、另存，Kioku 不保存它：丢了口令，文件就打不开

// 导出文件的大小上限（加密后的整个文件），导入时按它限制上传。导出时超出的直接拒绝，不给出导入不了的文件
export const SPACE_EXPORT_MAX_BYTES = 32 * 1024 * 1024

// 导出时口令至少这么长：文件可能放在不那么可信的地方，只靠口令挡住离线猜测
export const SPACE_EXPORT_PASSPHRASE_MIN = 12
const PASSPHRASE_MAX = 1024

export const SpaceExportRequest = z.object({
  passphrase: z
    .string()
    .min(SPACE_EXPORT_PASSPHRASE_MIN, `口令至少 ${SPACE_EXPORT_PASSPHRASE_MIN} 位`)
    .max(PASSPHRASE_MAX, `口令最多 ${PASSPHRASE_MAX} 位`),
})
export type SpaceExportRequest = z.infer<typeof SpaceExportRequest>

// 上传的表单：导出文件、导出时设的口令，以及新空间的名字（留空时用导出时的空间名）。
// 口令只要求不为空：以后调高长度要求时，之前导出的文件照样能导入
export const SpaceImportForm = z.object({
  file: z
    .file('要上传导出文件')
    .max(SPACE_EXPORT_MAX_BYTES, `文件超过 ${SPACE_EXPORT_MAX_BYTES / 1024 / 1024} MB 的上限`)
    .meta({ type: 'string', format: 'binary' }),
  passphrase: z.string().min(1, '要填导出时设的口令').max(PASSPHRASE_MAX),
  name: z.string().trim().max(64, '空间名最多 64 个字').optional(),
})
export type SpaceImportForm = z.infer<typeof SpaceImportForm>

export const SpaceImportResult = z.object({
  spaceId: z.uuid(),
  name: z.string(),
  // 导入了多少：记忆里 secret 的条数单独列出（它们用这个实例的主密钥重新加密了）
  counts: z.object({
    personas: z.number().int(),
    apps: z.number().int(),
    subjects: z.number().int(),
    memories: z.number().int(),
    secrets: z.number().int(),
    credentials: z.number().int(),
    providers: z.number().int(),
  }),
})
export type SpaceImportResult = z.infer<typeof SpaceImportResult>
