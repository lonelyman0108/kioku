import { z } from 'zod'

// 层：这条记忆属于谁
export const LAYERS = ['base', 'persona', 'app', 'owner', 'private', 'subject', 'episode'] as const
export const Layer = z.enum(LAYERS).meta({ id: 'Layer' })
export type Layer = z.infer<typeof Layer>

// 不由 URI 决定的层：新建时可以选、之后可以直接互改。人格层与应用层由 persona:// 与 app:// 决定，
// 对象层与情节层由对话抽取写入
export const PLAIN_LAYERS = ['base', 'owner', 'private'] as const
export const PlainLayer = z.enum(PLAIN_LAYERS)
export type PlainLayer = z.infer<typeof PlainLayer>

// 敏感级：能给谁看，按从宽到严排列，比较大小时用下标
export const SENSITIVITIES = ['public', 'internal', 'private', 'secret'] as const
export const Sensitivity = z.enum(SENSITIVITIES).meta({ id: 'Sensitivity' })
export type Sensitivity = z.infer<typeof Sensitivity>

// 写入来源：untrusted 只能写 subject 与 episode，且不参与跨作用域的自动注入
export const PROVENANCES = ['owner', 'agent', 'untrusted', 'system'] as const
export const Provenance = z.enum(PROVENANCES).meta({ id: 'Provenance' })
export type Provenance = z.infer<typeof Provenance>

// 形态：curated 是 URI 树上的策展节点，extracted 是从对话自动抽取的扁平事实
export const MEMORY_FORMS = ['curated', 'extracted'] as const
export const MemoryForm = z.enum(MEMORY_FORMS)
export type MemoryForm = z.infer<typeof MemoryForm>

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const
export const MemberRole = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof MemberRole>

export const SUBJECT_KINDS = ['person', 'group'] as const
export const SubjectKind = z.enum(SUBJECT_KINDS)
export type SubjectKind = z.infer<typeof SubjectKind>

// API Key 的授权上限；会话上下文和应用配置只能在它之内继续收紧
export const KeyScopes = z.object({
  readLayers: z.array(Layer),
  writeLayers: z.array(Layer),
  maxSensitivity: Sensitivity,
  admin: z.boolean(),
})
export type KeyScopes = z.infer<typeof KeyScopes>
