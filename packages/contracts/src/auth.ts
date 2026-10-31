import { z } from 'zod'

import { KeyScopes, Layer, MemberRole, Sensitivity } from './memory'

export const Username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{1,31}$/, '用户名只能包含小写字母、数字和 _.-，长度 2 到 32 位')
export const Password = z.string().min(10, '密码至少 10 位').max(256)
export const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, '只能包含小写字母、数字和连字符')

export const SetupStatus = z.object({ needsSetup: z.boolean() })
export type SetupStatus = z.infer<typeof SetupStatus>

export const SetupRequest = z.object({
  username: Username,
  displayName: z.string().min(1).max(64),
  password: Password,
  spaceName: z.string().min(1).max(64),
})
export type SetupRequest = z.infer<typeof SetupRequest>

// 长度上限挡住超长输入：用户名会作为失败计数表的主键写入
export const LoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().max(256),
})
export type LoginRequest = z.infer<typeof LoginRequest>

export const SpaceSummary = z.object({ id: z.uuid(), name: z.string(), role: MemberRole })
export type SpaceSummary = z.infer<typeof SpaceSummary>

// 空间成员：成员之间互相看得到名字与角色（活动里本来就显示操作者）
export const MemberInfo = z.object({
  accountId: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  role: MemberRole,
})
export type MemberInfo = z.infer<typeof MemberInfo>

export const Me = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  // 实例管理员：能改嵌入模型等全实例设置
  isAdmin: z.boolean(),
  spaces: z.array(SpaceSummary),
})
export type Me = z.infer<typeof Me>

export const RUNTIME_FAMILIES = [
  'claudecode',
  'codex',
  'openclaw',
  'hermes',
  'opencode',
  'pi',
  'astrbot',
  'mcp',
  'other',
] as const
export const RuntimeFamily = z.enum(RUNTIME_FAMILIES)
export type RuntimeFamily = z.infer<typeof RuntimeFamily>

export const AppConfig = z
  .object({
    elevateOwnerDirect: z.literal('internal').optional(),
    // 召回事件里记不记提示语（前 200 字，像凭据的片段打码）；不设时记
    recordPrompt: z.boolean().optional(),
  })
  .meta({ id: 'AppConfig' })
export type AppConfig = z.infer<typeof AppConfig>

export const CreateAppRequest = z.object({
  slug: Slug,
  name: z.string().min(1).max(64),
  runtimeFamily: RuntimeFamily,
  defaultPersonaId: z.uuid().nullable().default(null),
  config: AppConfig.default({}),
})
export type CreateAppRequest = z.infer<typeof CreateAppRequest>

export const UpdateAppRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  // 只有空间 owner 能改：把应用转给空间里的另一个成员
  ownerAccountId: z.uuid().optional(),
  defaultPersonaId: z.uuid().nullable().optional(),
  config: AppConfig.optional(),
})
export type UpdateAppRequest = z.infer<typeof UpdateAppRequest>

export const PersonaInfo = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  extendsId: z.uuid().nullable(),
  description: z.string().nullable(),
})
export type PersonaInfo = z.infer<typeof PersonaInfo>

export const CreatePersonaRequest = z.object({
  slug: Slug,
  name: z.string().min(1).max(64),
  extendsId: z.uuid().nullable().default(null),
  description: z.string().max(500).nullable().default(null),
})
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequest>

// 标识不能改：人格层记忆的 URI（persona://<标识>/…）里写着它
export const UpdatePersonaRequest = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  // 不能成环，继承链（含自己）最多 8 层
  extendsId: z.uuid().nullable().optional(),
})
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequest>

// 人格详情里的一个人格层节点
export const PersonaNode = z.object({
  uri: z.string(),
  personaId: z.uuid(),
  priority: z.number().int(),
  sensitivity: Sensitivity,
  disclosure: z.string().nullable(),
  // 被继承链上更近的人格的哪个节点覆盖（同一相对路径）；没被覆盖时为 null
  overriddenBy: z.string().nullable(),
})
export type PersonaNode = z.infer<typeof PersonaNode>

export const AppRef = z.object({ id: z.uuid(), slug: z.string(), name: z.string() })
export type AppRef = z.infer<typeof AppRef>

// 节点按查看者在管理界面里读得到的算：私人层不在人格层里，secret 只给读得到的成员
export const PersonaDetail = PersonaInfo.extend({
  // 从直接继承的那个到最远的祖先
  ancestors: z.array(PersonaInfo),
  // 直接继承它的人格
  children: z.array(PersonaInfo),
  // 自己的节点
  own: z.array(PersonaNode),
  // 祖先的节点：overriddenBy 为 null 的继承下来，不为 null 的被覆盖
  inherited: z.array(PersonaNode),
  // 默认人格是它的应用
  apps: z.array(AppRef),
  // 查看者在管理界面里看得到的人格层记忆总数，含已删除、已过期的：删除人格会把它们连带硬删除，
  // 所以有记忆时删不掉（删除时还会算上查看者读不到的）
  storedMemories: z.number().int(),
})
export type PersonaDetail = z.infer<typeof PersonaDetail>

export const AppInfo = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    runtimeFamily: z.string(),
    ownerAccountId: z.uuid(),
    defaultPersonaId: z.uuid().nullable(),
    config: AppConfig,
  })
  .meta({ id: 'AppInfo' })
export type AppInfo = z.infer<typeof AppInfo>

// 按群换人格：带着这个群（或频道）的会话上下文的请求用规则里的人格，boot、召回与写入都按它；
// 没有规则的群、私聊与不带上下文的请求（GET /boot、MCP）用默认人格
export const GroupPersonaRule = z.object({ subjectId: z.uuid(), personaId: z.uuid() })
export type GroupPersonaRule = z.infer<typeof GroupPersonaRule>

// 整组替换：没列出的规则删掉
export const GroupPersonaRules = z.object({ rules: z.array(GroupPersonaRule).max(200) })
export type GroupPersonaRules = z.infer<typeof GroupPersonaRules>

// 列出规则时带上群现在的名字，管理界面按名字显示
export const GroupPersonaRuleView = GroupPersonaRule.extend({ groupName: z.string() })
export type GroupPersonaRuleView = z.infer<typeof GroupPersonaRuleView>
export const GroupPersonaRuleList = z.object({ rules: z.array(GroupPersonaRuleView) })
export type GroupPersonaRuleList = z.infer<typeof GroupPersonaRuleList>

export const CreateKeyRequest = z.object({
  name: z.string().min(1).max(64),
  scopes: KeyScopes,
})
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>

export const KeyInfo = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  // 签发上限
  scopes: KeyScopes,
  // 当前有效上限：签发上限按应用主人现在的角色收紧。Key 已吊销，或主人已经离开空间
  // （离开后重新加入的，离开之前签发的 Key 不恢复）时为 null，Key 用不了
  effectiveScopes: KeyScopes.nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
})
export type KeyInfo = z.infer<typeof KeyInfo>

// 只在创建时返回一次明文
export const CreatedKey = KeyInfo.extend({ key: z.string() })
export type CreatedKey = z.infer<typeof CreatedKey>

// 权限矩阵的会话上下文：无上下文（本机 agent）、陌生人私聊、主人私聊、群聊、定时任务与子 agent
export const ACCESS_CONTEXTS = ['none', 'direct', 'owner_direct', 'group', 'cron'] as const
export const AccessContext = z.enum(ACCESS_CONTEXTS)
export type AccessContext = z.infer<typeof AccessContext>

// 一格：这一层这一级的记忆。read 为 explicit 时只能按 URI 显式读取（secret），recall 时也进召回与 boot。
// 对象层与情节层的 write 指对话抽取能写进去，不能按 URI 直接写
export const AccessCell = z.object({
  read: z.enum(['none', 'explicit', 'recall']),
  write: z.boolean(),
})
export type AccessCell = z.infer<typeof AccessCell>

export const AccessMatrixRow = z.object({
  layer: Layer,
  cells: z.array(AccessCell.extend({ sensitivity: Sensitivity })),
})

// 一把 Key 在各种会话上下文下实际能读写什么，按当前有效上限与应用配置计算
export const KeyAccessMatrix = z.object({
  contexts: z.array(
    z.object({
      context: AccessContext,
      rows: z.array(AccessMatrixRow),
      // 读得到哪些来源作用域写下的记忆：any 不限；app 只含全局与本应用写下的；
      // group、direct 再加上本群、与此人的对话里写下的
      originScope: z.enum(['any', 'app', 'group', 'direct']),
    }),
  ),
})
export type KeyAccessMatrix = z.infer<typeof KeyAccessMatrix>

export const WhoAmI = z
  .object({
    spaceId: z.uuid(),
    app: AppInfo,
    scopes: KeyScopes,
  })
  .meta({ id: 'WhoAmI' })
export type WhoAmI = z.infer<typeof WhoAmI>

export const ErrorResponse = z.object({ error: z.string() }).meta({ id: 'ErrorResponse' })
export type ErrorResponse = z.infer<typeof ErrorResponse>
