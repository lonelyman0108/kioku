import {
  CREDENTIAL_CAPABILITY_NAMES,
  CREDENTIAL_HOSTED_NAME,
  CREDENTIAL_ROTATION_NAME,
  LAYER_NAMES,
  SENSITIVITY_NAMES,
  type AccessContext,
  type ActivityItem,
  type AppInfo,
  type BenchMark,
  type CredentialSource,
  type EventActor,
  type KeyAccessMatrix,
  type KeyScopes,
  type OriginScope,
  type Provenance,
  type ReadDenial,
  type RecallSource,
  type SessionExtra,
} from '@kioku/contracts'

import { icons } from './icons'

export const layerLabels = LAYER_NAMES

export const sensitivityLabels = SENSITIVITY_NAMES

// Key 的 admin 在界面上不叫 admin，免得被当成空间管理员
export const ADMIN_SCOPE_LABEL = '跨人格 / 应用写入'

// 访问密钥的凭据能力：不可用、取用、管理
export const credentialCapabilityLabels = CREDENTIAL_CAPABILITY_NAMES

// 一个 Key 的权限，一句话说完
export const scopesSummary = (s: KeyScopes) =>
  `可读 ${s.readLayers.length} 类归属，可写 ${s.writeLayers.length} 类，最高${sensitivityLabels[s.maxSensitivity]}${s.admin ? `，${ADMIN_SCOPE_LABEL}` : ''}${s.credentials !== 'none' ? `，凭据${credentialCapabilityLabels[s.credentials]}` : ''}`

export const accessContextLabels: Record<AccessContext, string> = {
  none: '无上下文（本机 Agent）',
  direct: '陌生人私聊',
  owner_direct: '本人私聊',
  group: '群聊',
  cron: '定时任务 / 子 Agent',
}

// 五根小岩芯下面放不下全称时用的简称，全称放在悬停和读屏里
export const accessContextShortLabels: Record<AccessContext, string> = {
  none: '无上下文',
  direct: '陌生人私聊',
  owner_direct: '本人私聊',
  group: '群聊',
  cron: '定时任务',
}

// 权限范围里「读得到哪些来源作用域写下的记忆」
export const originScopeLabels: Record<KeyAccessMatrix['contexts'][number]['originScope'], string> =
  {
    any: '来源不限',
    app: '来源仅限全局与本应用',
    group: '来源仅限全局、本应用与本群',
    direct: '来源仅限全局、本应用与此人的对话',
  }

// 召回事件的来路
export const recallSourceLabels: Record<RecallSource, string> = {
  'session.start': '会话开始',
  'prompt.submit': '每轮输入',
  'mcp.search': 'MCP 搜索',
  'rest.recall': 'REST 召回',
}

// 会话开始时附在启动加载后面的几块，放不下、没有附上时说是哪几块
export const sessionExtraLabels: Record<SessionExtra, string> = {
  summaries: '会话摘要',
  recent: '近期更新的记忆',
  related: '与当前项目相关的记忆',
}

// 召回调试里一条记忆被当前 Key 过滤掉的原因
export const readDenialLabels: Record<ReadDenial, string> = {
  deleted: '已删除',
  expired: '已失效或过期',
  layer: '超出访问密钥的可读归属',
  sensitivity: '超出访问密钥的敏感级上限',
  secret: '机密内容仅可按坐标读取，不参与召回',
  origin: '来源范围不匹配',
  owner: '属于其他成员',
  persona: '不在当前人格的继承链上',
  app: '属于其他应用',
  override: '已被更近的人格节点覆盖',
}

// 表单上的坐标格式提示。契约里那句是给接口与 MCP 的，四种开头各放什么都写了；界面上只说格式
export const URI_FORMAT_HINT =
  '坐标只能以 core://、user://、persona://<人格标识>/ 或 app://<应用标识>/ 开头，各段只用小写字母、数字、_ 或 -'

export const provenanceLabels: Record<Provenance, string> = {
  owner: '本人',
  agent: 'Agent',
  untrusted: '未确认来源',
  system: '系统',
}

// 记忆事件的类型：服务端写入时用的名字
export const eventLabels: Record<string, { label: string; icon: string }> = {
  create: { label: '新建', icon: icons.add },
  import: { label: '导入', icon: icons.imported },
  sync: { label: '同步导入', icon: icons.imported },
  update: { label: '修改', icon: icons.edit },
  move: { label: '移动', icon: icons.moved },
  delete: { label: '删除', icon: icons.remove },
  restore: { label: '恢复旧版本', icon: icons.restore },
  undelete: { label: '恢复', icon: icons.undelete },
  expire: { label: '过期并释放坐标', icon: icons.expired },
  reactivate: { label: '恢复生效', icon: icons.reactivate },
  confirm: { label: '确认来源', icon: icons.confirmed },
  convert_credential: { label: '转存为凭据', icon: icons.credentials },
  ignore_plaintext: { label: '忽略明文提示', icon: icons.left },
  unignore_plaintext: { label: '撤销忽略', icon: icons.undelete },
  access: { label: '查看正文', icon: icons.reveal },
}

// 机密记忆的访问事件经由哪里
export const memoryViaLabels: Record<string, string> = {
  console: '在管理界面查看',
  export: '随空间导出',
  rest: '通过 REST 接口',
  kioku_get: '通过 kioku_get',
  kioku_list: '通过 kioku_list',
  kioku_update: '修改后的结果（kioku_update）',
  kioku_move: '移动后的结果（kioku_move）',
}

export function eventLabel(type: string): { label: string; icon: string } {
  return eventLabels[type] ?? { label: type, icon: icons.edit }
}

// 记忆从哪里来：哪个群、和谁的私聊、哪个应用；名字为空说明那个群、联系人或应用已经删掉了
export function originScopeText(scope: OriginScope): string {
  switch (scope.kind) {
    case 'group':
      return scope.name ? `群「${scope.name}」` : '已删除的群'
    case 'direct':
      return scope.name ? `与「${scope.name}」的私聊` : '已删除的联系人'
    case 'app':
      return scope.name ? `应用「${scope.name}」` : '已删除的应用'
    default:
      return '全局'
  }
}

// 变更记录里的一行能不能点过去。记忆已经删除（包括过期后释放坐标的）或过期了，按坐标打开的是那里别的记忆、
// 或者读不到；离开了可见范围的坐标是改动之前的。这几种不给链接，同一条记忆更早的改动也一样
export const activityLinkable = (item: Pick<ActivityItem, 'left' | 'deleted' | 'expired'>) =>
  !item.left && !item.deleted && !item.expired

// 谁做的：管理界面里是成员；通过 Key 写入时是应用（Key 的名字只给应用主人与空间 owner）
export function actorLabel(actor: EventActor): { name: string; viaApp: boolean } {
  if (actor.accountName) return { name: actor.accountName, viaApp: false }
  if (actor.appName) {
    return {
      name: actor.keyName ? `${actor.appName}（${actor.keyName}）` : actor.appName,
      viaApp: true,
    }
  }
  return { name: '未知', viaApp: false }
}

// 测试台真实模式写下的事件：操作的账号，账号已经删掉时没有名字
export const benchAccountLabel = (mark: BenchMark) => mark.accountName ?? '已删除的账号'

// 变更记录里「改了哪些字段」
export const changeLabels: Record<string, string> = {
  content: '正文',
  title: '标题',
  disclosure: '触发场景',
  priority: '优先级',
  sensitivity: '敏感级',
  layer: '归属',
  uri: '坐标',
  glossary: '关键词',
  validTo: '有效期',
}

export const credentialSourceLabels: Record<CredentialSource, string> = {
  hosted: CREDENTIAL_HOSTED_NAME,
  vault: '密码库',
}

// 凭据事件：只有凭据的所有者看得到，不进空间的变更记录
export const credentialEventLabels: Record<string, { label: string; icon: string }> = {
  create: { label: '新建', icon: icons.add },
  import: { label: '从导出文件导入', icon: icons.imported },
  update: { label: '修改', icon: icons.edit },
  delete: { label: '删除', icon: icons.remove },
  undelete: { label: '恢复', icon: icons.undelete },
  access: { label: '取用', icon: icons.reveal },
}

// 取用经由哪里
export const credentialViaLabels: Record<string, string> = {
  console: '在管理界面查看',
  space_export: '随空间导出',
  kioku_credential: '通过 kioku_credential',
  run: '通过 kioku run',
  rest: '通过 REST 接口',
}

export const credentialChangeLabels: Record<string, string> = {
  name: '名称',
  description: '说明',
  values: '值',
  fields: '字段对应',
  appIds: '限定的应用',
  expiresAt: '到期时间',
  needsRotation: CREDENTIAL_ROTATION_NAME,
}

// 凭据限定给哪些应用，显示成名字。应用列表还没读出来时不下结论；不是自己的应用标出来：
// Key 按应用所有者取凭据，别人的应用的 Key 取不到这些凭据
export function restrictedAppsLabel(
  appIds: readonly string[] | null,
  apps: readonly AppInfo[] | undefined,
  me: string | undefined,
): string {
  if (appIds === null) return '不限定'
  if (!appIds.length) return '不开放给任何应用'
  if (!apps) return '…'
  return appIds
    .map((id) => {
      const app = apps.find((a) => a.id === id)
      if (!app) return '已删除的应用'
      return app.ownerAccountId === me ? app.name : `${app.name}（非当前账号的应用，不可用）`
    })
    .join('、')
}

// 保存记忆前对一处疑似明文的选择
export const plaintextChoiceLabels = {
  convert: '转存为凭据',
  ignore: '不是凭据',
} as const satisfies Record<'convert' | 'ignore', string>
