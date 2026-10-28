import { z } from 'zod'

import { SubjectKind } from './memory'
import { OriginScope } from './subjects'

// 待审队列：不可信来源（群聊、陌生人私聊）写进对象层与情节层、现在还有效的记忆。
// 确认之后来源改成主人；删除和删记忆一样，留着历史

export const REVIEW_LAYERS = ['subject', 'episode'] as const
export const ReviewLayer = z.enum(REVIEW_LAYERS)
export type ReviewLayer = z.infer<typeof ReviewLayer>

export const ReviewItem = z.object({
  id: z.uuid(),
  layer: ReviewLayer,
  // Key 在群聊里写的策展记忆有 URI，从对话里抽取的没有
  uri: z.string().nullable(),
  content: z.string(),
  // 对象层的记忆挂在哪个对象上；情节层的为 null
  subject: z.object({ id: z.uuid(), kind: SubjectKind, displayName: z.string() }).nullable(),
  scope: OriginScope,
  // 处理时带回来：看过之后被改过的不处理，免得确认了没看过的内容
  version: z.number().int(),
  createdAt: z.iso.datetime(),
})
export type ReviewItem = z.infer<typeof ReviewItem>

// cursor 是上一页返回的 nextCursor，换了筛选就要从头翻
export const ReviewQuery = z.object({
  layer: ReviewLayer.optional(),
  cursor: z.string().max(200).optional(),
})
export type ReviewQuery = z.infer<typeof ReviewQuery>

export const ReviewList = z.object({
  items: z.array(ReviewItem),
  // 符合筛选的待审条数，只在第一页（不带 cursor）给
  total: z.number().int().nullable(),
  nextCursor: z.string().nullable(),
})
export type ReviewList = z.infer<typeof ReviewList>

export const ReviewRequest = z.object({
  action: z.enum(['confirm', 'delete']),
  // 每一条带上列表里看到的版本
  items: z
    .array(z.object({ id: z.uuid(), version: z.number().int() }))
    .min(1)
    .max(100),
})
export type ReviewRequest = z.infer<typeof ReviewRequest>

// 已经不在队列里的（别人处理过、删掉了、读不到）与看过之后被改过的跳过，计进 skipped
export const ReviewResult = z.object({
  done: z.number().int(),
  skipped: z.number().int(),
})
export type ReviewResult = z.infer<typeof ReviewResult>
