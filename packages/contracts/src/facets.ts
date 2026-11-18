import { z } from 'zod'

// 切面维度匹配模式：exclusive 同维出现非空无交集时判为互斥冲突（boot 剥离、recall 扣分）；
// additive 同维未命中仅不加分，不强排斥
export const FACET_MATCH_MODES = ['exclusive', 'additive'] as const
export const FacetMatchMode = z.enum(FACET_MATCH_MODES)
export type FacetMatchMode = z.infer<typeof FacetMatchMode>

// 四大内置切面维常量：元定义固化于契约，不存全局库表行；词表项均按圈（circle_id）隔离存储
export const BUILTIN_FACET_KEYS = ['realm', 'env', 'runtime', 'project'] as const
export type BuiltinFacetKey = (typeof BUILTIN_FACET_KEYS)[number]

export interface BuiltinFacetDimension {
  key: BuiltinFacetKey
  name: string
  matchMode: FacetMatchMode
  autoRegister: boolean
  description: string
}

export const BUILTIN_FACET_DIMENSIONS: Record<BuiltinFacetKey, BuiltinFacetDimension> = {
  realm: {
    key: 'realm',
    name: '场域',
    matchMode: 'exclusive',
    autoRegister: false,
    description: '所处场域，例如工作、家里、个人',
  },
  env: {
    key: 'env',
    name: '环境与设备',
    matchMode: 'exclusive',
    autoRegister: false,
    description: '运行环境、操作系统或具体机器名',
  },
  runtime: {
    key: 'runtime',
    name: '客户端',
    matchMode: 'exclusive',
    autoRegister: false,
    description: '适用的客户端或接入运行时',
  },
  project: {
    key: 'project',
    name: '项目仓库',
    matchMode: 'additive',
    autoRegister: true,
    description: '项目或代码仓库标识，可随请求自动登记并关联到场域',
  },
}

const BUILTIN_KEY_SET: ReadonlySet<string> = new Set(BUILTIN_FACET_KEYS)

export function isBuiltinFacetKey(key: string): key is BuiltinFacetKey {
  return BUILTIN_KEY_SET.has(key)
}

export const MAX_CUSTOM_FACET_DIMENSIONS = 32
export const MAX_WHEN_DIMENSIONS = 16
export const MAX_WHEN_TERMS_PER_DIMENSION = 16
export const MAX_FACET_ALIASES = 32
export const MAX_FACET_IMPLIES_DEPTH = 4

export const FacetDimensionKey = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, '维度键只能包含小写字母、数字和下划线，须以字母开头')

// 自定义维度键不能占用四大内置维度
export const CustomFacetDimensionKey = FacetDimensionKey.refine(
  (k) => !BUILTIN_KEY_SET.has(k),
  '不能使用内置维度键名 realm、env、runtime、project',
)

// 切面词条标识：支持小写字母、数字、._- 与常见中日韩字符，禁止空白、控制字符、分隔符或凭据占位符
export const FACET_TERM_SLUG_PATTERN = /^[a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]{1,64}$/
export const FacetTermSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(FACET_TERM_SLUG_PATTERN, '词条标识只能包含小写字母、数字、中文、._-，长度 1 到 64 个字符')
  .refine((v) => !v.includes('{{cred:'), '词条标识不能包含凭据占位符')

// 触发词别名（aliases）：用于提问破壁，长度至少 2 个字符
export const FacetAlias = z
  .string()
  .trim()
  .min(2, '触发词至少 2 个字符')
  .max(48, '触发词最多 48 个字符')
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, '触发词不能包含控制字符')

// 变体切片条件 / 终端在场切面：dimensionKey -> termSlug[]
export const WhenCondition = z
  .record(FacetDimensionKey, z.array(FacetTermSlug).max(MAX_WHEN_TERMS_PER_DIMENSION))
  .refine(
    (obj) => Object.keys(obj).length <= MAX_WHEN_DIMENSIONS,
    `最多指定 ${MAX_WHEN_DIMENSIONS} 个切面维度`,
  )
  .transform((obj) => normalizeWhen(obj))
export type WhenCondition = z.infer<typeof WhenCondition>

// 记忆圈默认切面与词条蕴含展开表
export const DefaultFacets = WhenCondition
export type DefaultFacets = WhenCondition

export const FacetImplies = WhenCondition
export type FacetImplies = WhenCondition

// 规范化切面条件：剔除空数组、维度键按字母序排列、每个维度下词条去重并排序
export function normalizeWhen(
  raw?: Record<string, readonly string[]> | null,
): Record<string, string[]> {
  if (!raw) return {}
  const keys = Object.keys(raw).sort()
  const out: Record<string, string[]> = {}
  for (const rawKey of keys) {
    const key = rawKey.trim().toLowerCase()
    if (!key) continue
    const list = raw[rawKey] ?? []
    const unique = [...new Set(list.map((v) => v.trim().toLowerCase()).filter(Boolean))].sort()
    if (unique.length) out[key] = unique
  }
  return out
}

// 确定性签名：用于同词条内变体切面唯一约束（when_signature 列）与精确更新/删除定位
export function whenSignature(raw?: Record<string, readonly string[]> | null): string {
  return JSON.stringify(normalizeWhen(raw))
}

export const FacetDimensionView = z.object({
  key: z.string(),
  name: z.string(),
  matchMode: FacetMatchMode,
  builtin: z.boolean(),
  autoRegister: z.boolean(),
  description: z.string().nullable(),
})
export type FacetDimensionView = z.infer<typeof FacetDimensionView>

export const CreateFacetDimensionRequest = z.object({
  key: CustomFacetDimensionKey,
  name: z.string().trim().min(1, '请填写维度名称').max(64, '维度名称最多 64 个字'),
  matchMode: FacetMatchMode.default('exclusive'),
  description: z.string().trim().max(200).nullable().default(null),
})
export type CreateFacetDimensionRequest = z.infer<typeof CreateFacetDimensionRequest>

export const UpdateFacetDimensionRequest = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  matchMode: FacetMatchMode.optional(),
  description: z.string().trim().max(200).nullable().optional(),
})
export type UpdateFacetDimensionRequest = z.infer<typeof UpdateFacetDimensionRequest>

export const FacetTermView = z.object({
  id: z.uuid(),
  circleId: z.uuid(),
  dimensionKey: z.string(),
  slug: z.string(),
  label: z.string(),
  implies: FacetImplies,
  aliases: z.array(z.string()),
  autoRegistered: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type FacetTermView = z.infer<typeof FacetTermView>

export const CreateFacetTermRequest = z.object({
  dimensionKey: FacetDimensionKey,
  slug: FacetTermSlug,
  label: z.string().trim().min(1, '请填写显示名称').max(64, '显示名称最多 64 个字'),
  implies: FacetImplies.default({}),
  aliases: z.array(FacetAlias).max(MAX_FACET_ALIASES).default([]),
})
export type CreateFacetTermRequest = z.infer<typeof CreateFacetTermRequest>

export const UpdateFacetTermRequest = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  implies: FacetImplies.optional(),
  aliases: z.array(FacetAlias).max(MAX_FACET_ALIASES).optional(),
})
export type UpdateFacetTermRequest = z.infer<typeof UpdateFacetTermRequest>

export const FacetVocabularyView = z.object({
  circleId: z.uuid(),
  dimensions: z.array(FacetDimensionView),
  terms: z.array(FacetTermView),
})
export type FacetVocabularyView = z.infer<typeof FacetVocabularyView>
