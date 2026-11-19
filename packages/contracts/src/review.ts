import { z } from 'zod'

import { OriginScope } from './conversations'
import { ShortId } from './links'
import { SubjectKind } from './memory'

export const REVIEW_KINDS = ['fact', 'episode'] as const
export const ReviewKind = z.enum(REVIEW_KINDS)
export type ReviewKind = z.infer<typeof ReviewKind>

export const ReviewItem = z.object({
  id: z.uuid(),
  shortId: ShortId,
  title: z.string(),
  kind: ReviewKind,
  content: z.string(),
  subject: z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() }).nullable(),
  scope: OriginScope,
  version: z.number().int(),
  createdAt: z.iso.datetime(),
})
export type ReviewItem = z.infer<typeof ReviewItem>

export const ReviewQuery = z.object({
  kind: ReviewKind.optional(),
  cursor: z.string().max(200).optional(),
})
export type ReviewQuery = z.infer<typeof ReviewQuery>

export const ReviewList = z.object({
  items: z.array(ReviewItem),
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
})
export type ReviewList = z.infer<typeof ReviewList>

export const ReviewRequest = z.object({
  action: z.enum(['confirm', 'delete']),
  items: z
    .array(z.object({ id: z.uuid(), version: z.number().int() }))
    .min(1)
    .max(100)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
      message: '同一条只能出现一次',
    }),
})
export type ReviewRequest = z.infer<typeof ReviewRequest>

export const ReviewResult = z.object({
  done: z.number().int(),
  skipped: z.number().int(),
})
export type ReviewResult = z.infer<typeof ReviewResult>
