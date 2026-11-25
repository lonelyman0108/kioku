import { z } from 'zod'

export const API_GENERATION = 3 as const

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  api: z.literal(API_GENERATION),
})
export type HealthResponse = z.infer<typeof HealthResponse>

export const UnavailableHealthResponse = z.object({
  status: z.literal('unavailable'),
  version: z.string(),
  api: z.literal(API_GENERATION),
  database: z.literal('unavailable'),
})
export type UnavailableHealthResponse = z.infer<typeof UnavailableHealthResponse>

export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>

// 提交的 sha（短的或完整的）
export const COMMIT_SHA = /^[0-9a-f]{7,40}$/i

// 正式版的版本号：X.Y.Z，前面可带 v；其余返回 null
export function releaseVersion(version: string): [number, number, number] | null {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

// 给人看的版本号：正式版前面加 v，其余原样
export function versionLabel(version: string): string {
  const release = releaseVersion(version)
  return release ? `v${release.join('.')}` : version
}
