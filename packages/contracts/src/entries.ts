import { z } from 'zod'

import { FacetTermSlug, normalizeWhen, WhenCondition, whenSignature } from './facets'
import { EntryLinkNeighbor, ShortId } from './links'
import { EntryKind, Provenance, Sensitivity, SubjectKind } from './memory'
import { StoredSensitiveFinding } from './sensitive'

export const ENTRY_TITLE_MAX = 200
export const DISCLOSURE_MAX = 500
export const ENTRY_CONTENT_MAX = 100_000
export const GLOSSARY_MAX = 50
export const TOPICS_MAX = 32
export const VARIANTS_MAX = 20

export const CREDENTIAL_PLACEHOLDER_PREFIX = '{{cred:'

export const EntryTitle = z
  .string()
  .trim()
  .min(1, '标题不能为空')
  .max(ENTRY_TITLE_MAX, `标题最多 ${ENTRY_TITLE_MAX} 个字符`)
  .regex(/^\P{Cc}*$/u, '标题不能含控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const TopicTag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, '主题标签不能为空')
  .max(64, '主题标签最多 64 个字符')
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+$/u, '主题标签不能包含空白或控制字符')
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

// 关键词至少两个字符：召回按关键词边界匹配，单字容易大面积误命中
export const Keyword = z
  .string()
  .trim()
  .min(2, '关键词至少两个字')
  .max(64)
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')
export const RemovableKeyword = z.string().trim().min(1).max(64)

const VALID_TO_FORMAT =
  'ISO 8601 的时间，要带时区（例如 2026-12-31T23:59:00+08:00 或 2026-12-31T15:59:00Z），不带时区的会被拒绝；要比现在晚至少一分钟'
export const ValidTo = z.iso.datetime({ offset: true }).describe(VALID_TO_FORMAT)

const Disclosure = z
  .string()
  .trim()
  .max(DISCLOSURE_MAX)
  .refine((v) => !v.includes(CREDENTIAL_PLACEHOLDER_PREFIX), '凭据占位符只能写在正文里')

export const VariantInput = z
  .object({
    when: WhenCondition.default({}),
    content: z.string().min(1, '正文不能为空').max(ENTRY_CONTENT_MAX),
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  .meta({ id: 'VariantInput' })
export type VariantInput = z.infer<typeof VariantInput>

export const EntryVariantView = z
  .object({
    id: z.uuid(),
    when: WhenCondition,
    whenSignature: z.string(),
    sortOrder: z.number().int(),
    // 机密切片仅显式读取或查看时解密返回，否则为 null
    content: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'EntryVariantView' })
export type EntryVariantView = z.infer<typeof EntryVariantView>

export const ConsoleVariantView = EntryVariantView.extend({
  contentHidden: z.boolean(),
  plaintextIgnored: z.boolean(),
  sensitiveFindings: z.array(StoredSensitiveFinding).optional(),
})
export type ConsoleVariantView = z.infer<typeof ConsoleVariantView>

export const OtherVariantHint = z.object({
  when: WhenCondition,
  whenSignature: z.string(),
})
export type OtherVariantHint = z.infer<typeof OtherVariantHint>

export const EntryView = z
  .object({
    id: z.uuid(),
    shortId: ShortId,
    circleId: z.uuid(),
    circleSlug: z.string().nullable(),
    kind: EntryKind,
    title: z.string(),
    sensitivity: Sensitivity,
    provenance: Provenance,
    originScope: z.string(),
    topics: z.array(z.string()),
    realms: z.array(z.string()),
    priority: z.number().int(),
    disclosure: z.string().nullable(),
    glossary: z.array(z.string()),
    validFrom: z.string(),
    validTo: z.string().nullable(),
    version: z.number().int(),
    variants: z.array(EntryVariantView),
    otherVariants: z.array(OtherVariantHint).default([]),
    links: z.array(EntryLinkNeighbor).default([]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'EntryView' })
export type EntryView = z.infer<typeof EntryView>

export const EntrySubjectRef = z.object({
  id: z.uuid(),
  kind: SubjectKind,
  displayName: z.string(),
})
export type EntrySubjectRef = z.infer<typeof EntrySubjectRef>

export const ConsoleEntryView = EntryView.extend({
  contentHidden: z.boolean(),
  plaintextIgnored: z.boolean(),
  variants: z.array(ConsoleVariantView),
  subject: EntrySubjectRef.nullable().default(null),
  conversationId: z.uuid().nullable().default(null),
  clientId: z.uuid().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
})
export type ConsoleEntryView = z.infer<typeof ConsoleEntryView>

export const RevealEntryRequest = z.object({ entryId: z.uuid() })
export type RevealEntryRequest = z.infer<typeof RevealEntryRequest>

export const PlaintextIgnoreRequest = z.object({
  entryId: z.uuid(),
  variantId: z.uuid().optional(),
  expectedVersion: z.number().int(),
})
export type PlaintextIgnoreRequest = z.infer<typeof PlaintextIgnoreRequest>

// 判断多变体切片是否保持同质场域（供 secret 机密词条禁止异 realm 切片渗透使用）
export function hasHomogeneousRealms(
  variants: readonly { when?: Record<string, readonly string[]> | null }[],
): boolean {
  if (variants.length <= 1) return true
  const baseline = JSON.stringify(normalizeWhen(variants[0]?.when).realm ?? [])
  for (let i = 1; i < variants.length; i++) {
    const current = JSON.stringify(normalizeWhen(variants[i]?.when).realm ?? [])
    if (current !== baseline) return false
  }
  return true
}

function hasDuplicateWhenSignatures(
  variants: readonly { when?: Record<string, readonly string[]> | null }[],
): boolean {
  const seen = new Set<string>()
  for (const variant of variants) {
    const sig = whenSignature(variant.when)
    if (seen.has(sig)) return true
    seen.add(sig)
  }
  return false
}

const KeyPlaintextFlags = {
  plaintextOk: z
    .boolean()
    .optional()
    .describe(
      '正文里新增的疑似明文确实不是凭据时设为 true：照常写入，这条词条进待处理。是凭据时先存成凭据，正文写占位符',
    ),
}

const ConsolePlaintextFlags = {
  ignorePlaintext: z.boolean().optional(),
  allowPlaintext: z.boolean().optional(),
}

// 统一创建词条请求体（同时兼容单切片简写与显式多变体 variants 数组）
const CreateEntryBase = z.object({
  circle: z.string().trim().min(1).max(64).optional(),
  title: EntryTitle.optional(),
  content: z.string().min(1).max(ENTRY_CONTENT_MAX).optional(),
  when: WhenCondition.optional(),
  variants: z.array(VariantInput).min(1).max(VARIANTS_MAX).optional(),
  topics: z.array(TopicTag).max(TOPICS_MAX).default([]),
  sensitivity: Sensitivity.optional(),
  priority: z.number().int().min(0).max(99).default(2),
  disclosure: Disclosure.optional(),
  glossary: z.array(Keyword).max(GLOSSARY_MAX).default([]),
  validTo: ValidTo.optional().describe(
    `有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；不填就一直有效`,
  ),
  ...KeyPlaintextFlags,
})

function validateCreateVariants(
  input: z.infer<typeof CreateEntryBase>,
  ctx: z.RefinementCtx,
): void {
  const hasContent = input.content !== undefined
  const hasVariants = input.variants !== undefined
  if (hasContent === hasVariants) {
    ctx.addIssue({
      code: 'custom',
      message: '请提供单切片 content 或多变体 variants（二选一）',
    })
    return
  }
  if (input.when !== undefined && hasVariants) {
    ctx.addIssue({
      code: 'custom',
      path: ['when'],
      message: '传入 variants 数组时请将各切片的 when 写在对应切片内',
    })
  }
  if (input.variants) {
    if (hasDuplicateWhenSignatures(input.variants)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: '同一词条下不能存在相同的切面条件切片',
      })
    }
    if (input.sensitivity === 'secret' && !hasHomogeneousRealms(input.variants)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: '机密词条下禁止挂载不同场域（realm）的变体切片',
      })
    }
  }
}

export const CreateEntryRequest = CreateEntryBase.superRefine(validateCreateVariants).meta({
  id: 'CreateEntryRequest',
})
export type CreateEntryRequest = z.infer<typeof CreateEntryRequest>

export const ConsoleCreateEntryRequest = CreateEntryBase.omit({ plaintextOk: true })
  .extend({ circleId: z.uuid().optional(), ...ConsolePlaintextFlags })
  .superRefine(validateCreateVariants)
export type ConsoleCreateEntryRequest = z.infer<typeof ConsoleCreateEntryRequest>

const UpdateEntryBase = z.object({
  // 支持 m-xxxxxx 短 ID、旧版 legacy_uri 或精确标题
  id: z.string().trim().min(1).max(2048),
  circle: z.string().trim().min(1).max(64).optional(),
  expectedVersion: z.number().int().optional(),
  title: EntryTitle.optional(),
  // 单切片更新默认切面或无条件切片 {}；与 variants / upsertVariants / removeVariantWhens 互斥规则见校验
  content: z.string().min(1).max(ENTRY_CONTENT_MAX).optional(),
  when: WhenCondition.optional(),
  variants: z.array(VariantInput).min(1).max(VARIANTS_MAX).optional(),
  upsertVariants: z.array(VariantInput).min(1).max(VARIANTS_MAX).optional(),
  removeVariantWhens: z.array(WhenCondition).min(1).max(VARIANTS_MAX).optional(),
  topics: z.array(TopicTag).max(TOPICS_MAX).optional(),
  sensitivity: Sensitivity.optional(),
  priority: z.number().int().min(0).max(99).optional(),
  disclosure: Disclosure.nullable().optional(),
  glossaryAdd: z.array(Keyword).max(GLOSSARY_MAX).optional(),
  glossaryRemove: z.array(RemovableKeyword).max(GLOSSARY_MAX).optional(),
  validTo: ValidTo.nullable()
    .optional()
    .describe(`有效到：${VALID_TO_FORMAT}。到期后不再召回、不进 boot；填 null 清掉，一直有效`),
  ...KeyPlaintextFlags,
})

function validateUpdateVariants(
  input: z.infer<typeof UpdateEntryBase>,
  ctx: z.RefinementCtx,
): void {
  if (input.variants !== undefined) {
    if (
      input.content !== undefined ||
      input.upsertVariants !== undefined ||
      input.removeVariantWhens !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: '整组替换 variants 不能与 content、upsertVariants 或 removeVariantWhens 同时传入',
      })
    }
    if (hasDuplicateWhenSignatures(input.variants)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: '同一词条下不能存在相同的切面条件切片',
      })
    }
    if (input.sensitivity === 'secret' && !hasHomogeneousRealms(input.variants)) {
      ctx.addIssue({
        code: 'custom',
        path: ['variants'],
        message: '机密词条下禁止挂载不同场域（realm）的变体切片',
      })
    }
  }
  if (input.content !== undefined && input.upsertVariants !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['upsertVariants'],
      message: 'content 与 upsertVariants 不能同时传入',
    })
  }
  if (input.upsertVariants && hasDuplicateWhenSignatures(input.upsertVariants)) {
    ctx.addIssue({
      code: 'custom',
      path: ['upsertVariants'],
      message: 'upsertVariants 中不能包含重复的切面条件',
    })
  }
}

export const UpdateEntryRequest = UpdateEntryBase.superRefine(validateUpdateVariants).meta({
  id: 'UpdateEntryRequest',
})
export type UpdateEntryRequest = z.infer<typeof UpdateEntryRequest>

export const ConsoleUpdateEntryRequest = UpdateEntryBase.omit({ plaintextOk: true })
  .extend(ConsolePlaintextFlags)
  .superRefine(validateUpdateVariants)
export type ConsoleUpdateEntryRequest = z.infer<typeof ConsoleUpdateEntryRequest>

export const GetEntryQuery = z.object({
  id: z.string().trim().min(1).max(2048),
  circle: z.string().trim().min(1).max(64).optional(),
  allVariants: z.coerce.boolean().optional(),
})
export type GetEntryQuery = z.infer<typeof GetEntryQuery>

export const DeleteEntryRequest = z
  .object({
    id: z.string().trim().min(1).max(2048),
    circle: z.string().trim().min(1).max(64).optional(),
    expectedVersion: z.number().int().optional(),
  })
  .meta({ id: 'DeleteEntryRequest' })
export type DeleteEntryRequest = z.infer<typeof DeleteEntryRequest>

// 跨圈迁移：访问密钥限在两个都有写权限的共享圈之间迁移；个人圈与共享圈互转仅限管理界面
export const TransferEntryRequest = z
  .object({
    id: z.string().trim().min(1).max(2048),
    fromCircle: z.string().trim().min(1).max(64).optional(),
    toCircle: z.string().trim().min(1).max(64),
    expectedVersion: z.number().int().optional(),
  })
  .meta({ id: 'TransferEntryRequest' })
export type TransferEntryRequest = z.infer<typeof TransferEntryRequest>

export const ConsoleTransferEntryRequest = z.object({
  entryId: z.uuid(),
  toCircleId: z.uuid(),
  expectedVersion: z.number().int().optional(),
})
export type ConsoleTransferEntryRequest = z.infer<typeof ConsoleTransferEntryRequest>

// 动态分组浏览（取代旧版按目录前缀列目录）
export const BROWSE_GROUP_BYS = [
  'circle',
  'realm',
  'env',
  'runtime',
  'project',
  'topic',
  'kind',
] as const
export const BrowseGroupBy = z.enum(BROWSE_GROUP_BYS)
export type BrowseGroupBy = z.infer<typeof BrowseGroupBy>

export const BrowseEntriesQuery = z
  .object({
    groupBy: BrowseGroupBy.default('topic'),
    circle: z.string().trim().min(1).max(64).optional(),
    kind: EntryKind.optional(),
    topic: TopicTag.optional(),
    facets: WhenCondition.optional(),
    query: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .meta({ id: 'BrowseEntriesQuery' })
export type BrowseEntriesQuery = z.infer<typeof BrowseEntriesQuery>

export const EntryBrowseItem = z
  .object({
    id: z.uuid(),
    shortId: ShortId,
    title: z.string(),
    circleId: z.uuid(),
    circleSlug: z.string().nullable(),
    kind: EntryKind,
    sensitivity: Sensitivity,
    priority: z.number().int(),
    topics: z.array(z.string()),
    disclosure: z.string().nullable(),
    variantCount: z.number().int(),
    variantsSummary: z.array(WhenCondition),
  })
  .meta({ id: 'EntryBrowseItem' })
export type EntryBrowseItem = z.infer<typeof EntryBrowseItem>

export const EntryBrowseGroup = z
  .object({
    key: z.string(),
    label: z.string(),
    count: z.number().int(),
    items: z.array(EntryBrowseItem),
  })
  .meta({ id: 'EntryBrowseGroup' })
export type EntryBrowseGroup = z.infer<typeof EntryBrowseGroup>

export const EntryBrowseResponse = z
  .object({
    groupBy: BrowseGroupBy,
    groups: z.array(EntryBrowseGroup),
    truncated: z.boolean(),
  })
  .meta({ id: 'EntryBrowseResponse' })
export type EntryBrowseResponse = z.infer<typeof EntryBrowseResponse>

// 供维度筛选校验复用
export const FacetSlugList = z.array(FacetTermSlug).max(32)

// ---- 标题与 Markdown 首行提取（纯函数，服务端与测试共用）----

const HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CONTROL_RE = /\p{Cc}+/gu

function clipTitle(text: string): string {
  if (text.length <= ENTRY_TITLE_MAX) return text
  let out = ''
  for (const point of text) {
    if (out.length + point.length > ENTRY_TITLE_MAX) break
    out += point
  }
  return out.trim()
}

// 提取正文第一个 # 标题（忽略围栏代码块内及含凭据占位符的标题行）
export function firstMarkdownHeading(content: string): string | null {
  let fence: string | null = null
  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const [, marker, info = ''] = FENCE_RE.exec(line) ?? []
    if (fence !== null) {
      const closes = marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length
      if (closes && /^[ \t]*$/.test(info)) fence = null
      continue
    }
    if (marker && !(marker[0] === '`' && info.includes('`'))) {
      fence = marker
      continue
    }
    const heading = HEADING_RE.exec(line)?.[1]?.replace(CONTROL_RE, ' ').trim()
    if (heading) return heading.includes(CREDENTIAL_PLACEHOLDER_PREFIX) ? null : clipTitle(heading)
  }
  return null
}

export function markdownHeadingsOf(contents: Iterable<unknown>): Set<string> {
  const headings = new Set<string>()
  for (const content of contents) {
    const heading = typeof content === 'string' ? firstMarkdownHeading(content) : null
    if (heading) headings.add(heading)
  }
  return headings
}

// 计算词条最终标题：
// - 非机密：优先显式标题，其次首个切片首个 # 标题，再无则返回 shortId
// - 机密：禁止从正文取标题，若显式标题等于任一变体正文首个 # 标题则强制回退为 shortId
export function deriveEntryTitle(
  explicitTitle: string | null | undefined,
  variants: readonly { content?: string | null }[],
  shortId: string,
  sensitivity: Sensitivity,
): string {
  const trimmed = explicitTitle?.trim() || null
  const contents = variants.map((v) => v.content)
  if (sensitivity === 'secret') {
    if (!trimmed) return shortId
    const headings = markdownHeadingsOf(contents)
    return headings.has(trimmed) ? shortId : trimmed
  }
  if (trimmed) return trimmed
  for (const content of contents) {
    if (typeof content !== 'string') continue
    const heading = firstMarkdownHeading(content)
    if (heading) return heading
  }
  return shortId
}
