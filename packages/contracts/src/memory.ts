import { z } from 'zod'

// 归属：这条记忆是谁的（列名 layer），从通用到具体排列，也就是地层柱上自下而上的顺序。
// 前四类是记下的（form 为 curated），有坐标与标题，坐标的开头就是归属（见 memories.ts 的 URI_PATTERN）；
// 后两类来自对话（form 为 extracted），由抽取写入、没有坐标：subject 是挂在联系人上的事实，episode 是挂在会话上的会话摘要
export const LAYERS = ['core', 'persona', 'app', 'user', 'subject', 'episode'] as const
export const Layer = z.enum(LAYERS)
export type Layer = z.infer<typeof Layer>

// 记下的四类，也是坐标的四种开头：core://、persona://<人格标识>/、app://<应用标识>/、user://。
// 开头就是归属的取值，开头与归属的对应只在这里定义
export const CURATED_LAYERS = ['core', 'persona', 'app', 'user'] as const satisfies readonly Layer[]
export const CuratedLayer = z.enum(CURATED_LAYERS)
export type CuratedLayer = z.infer<typeof CuratedLayer>

// 开头之后的第一段是人格或应用的标识：persona://<人格标识>/…、app://<应用标识>/…
export const NAMESPACED_LAYERS = ['persona', 'app'] as const satisfies readonly CuratedLayer[]

// 启动加载只收受信来源写下的、记下的四类（理由见服务端的 recall/boot.ts）
export const BOOT_LAYERS: Layer[] = [...CURATED_LAYERS]

// 会进启动加载的节点：这几类里 priority 0 的，加上人格与应用 priority ≤ 1 的。受信来源是调用方的前提。
// 服务端的 SQL 版是 memory/filter.ts 的 BOOT_ELIGIBLE，改了要一起改，loreImport.int.test.ts 会拿写进去的行比对。
// 服务端的导入计划和管理界面的详情都用它
export function bootEligible(layer: Layer, priority: number): boolean {
  if (!BOOT_LAYERS.includes(layer)) return false
  return priority === 0 || ((layer === 'persona' || layer === 'app') && priority <= 1)
}

// 敏感级：能给谁看，按从宽到严排列，比较大小时用下标
export const SENSITIVITIES = ['public', 'internal', 'private', 'secret'] as const
export const Sensitivity = z.enum(SENSITIVITIES)
export type Sensitivity = z.infer<typeof Sensitivity>

// 这一类归属收不收这一级：本人（user）不设公开，本人的记忆到不了群聊与陌生人私聊，给了公开只会让人以为群里能用。
// 写入检查、权限范围与管理界面的选项都按它，库里另有检查约束兜底
export function sensitivityAllowed(layer: Layer, sensitivity: Sensitivity): boolean {
  return !(layer === 'user' && sensitivity === 'public')
}

// 记下的四类不给敏感级时的默认值：本人不设公开，默认私密，宁可收得紧；应用默认内部；人格与通用默认公开。
// 服务端的写入（含 Lore 导入）与管理界面的新建弹窗都按它，来自对话的两类由抽取按会话定
export const DEFAULT_SENSITIVITY: Record<CuratedLayer, Sensitivity> = {
  core: 'public',
  persona: 'public',
  app: 'internal',
  user: 'private',
}

// 写入来源：untrusted 只能写 subject 与 episode，且不参与跨作用域的自动注入
export const PROVENANCES = ['owner', 'agent', 'untrusted', 'system'] as const
export const Provenance = z.enum(PROVENANCES)
export type Provenance = z.infer<typeof Provenance>

// 形态：curated 是目录里有坐标与标题的记忆（通用、人格、应用、本人），extracted 是从对话抽取的
// 联系人的事实与会话摘要，没有坐标
export const MEMORY_FORMS = ['curated', 'extracted'] as const
export const MemoryForm = z.enum(MEMORY_FORMS)
export type MemoryForm = z.infer<typeof MemoryForm>

// 够格进启动加载的记忆：目录里的（form 为 curated），归属与优先级够格（bootEligible），来源受信（未确认来源的不进，
// 理由见服务端的 recall/boot.ts），不是机密（启动加载照读权限不收机密）。实际加载还看访问密钥的权限、继承覆盖与字数上限。
// 服务端的 SQL 版是 memory/filter.ts 的 BOOT_CANDIDATE（BOOT_ELIGIBLE 加上不是机密），改了要一起改，
// browse.int.test.ts 逐行比对。管理界面的 isBootNode 在它之外再除去已过期的
export function isBootCandidate(memory: {
  form: MemoryForm
  layer: Layer
  priority: number
  provenance: Provenance
  sensitivity: Sensitivity
}): boolean {
  return (
    memory.form === 'curated' &&
    memory.provenance !== 'untrusted' &&
    memory.sensitivity !== 'secret' &&
    bootEligible(memory.layer, memory.priority)
  )
}

export const MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const
export const MemberRole = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof MemberRole>

export const SUBJECT_KINDS = ['person', 'group'] as const
export const SubjectKind = z.enum(SUBJECT_KINDS)
export type SubjectKind = z.infer<typeof SubjectKind>

// 访问密钥的凭据能力：none 不可用；use 能列出凭据（不含值）、取值；manage 在此之上还能新建、修改、删除凭据。
// 取用与管理都还要能读本人、最高敏感级至少私密，管理还要能写本人。只有空间所有者的应用能有取用与管理
export const CREDENTIAL_CAPABILITIES = ['none', 'use', 'manage'] as const
export const CredentialCapability = z.enum(CREDENTIAL_CAPABILITIES)
export type CredentialCapability = z.infer<typeof CredentialCapability>

// API Key 的授权上限；会话上下文和应用配置只能在它之内继续收紧
export const KeyScopes = z.object({
  readLayers: z.array(Layer),
  writeLayers: z.array(Layer),
  maxSensitivity: Sensitivity,
  admin: z.boolean(),
  credentials: CredentialCapability.default('none'),
})
export type KeyScopes = z.infer<typeof KeyScopes>
