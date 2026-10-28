import type {
  AccessContext,
  AppInfo,
  CredentialProviderKind,
  CredentialSource,
  EventActor,
  KeyAccessMatrix,
  Layer,
  Provenance,
  ReadDenial,
  RecallSource,
  Sensitivity,
} from '@kioku/contracts'

import { icons } from './icons'

export const layerLabels: Record<Layer, string> = {
  base: '基础',
  persona: '人格',
  app: '应用',
  owner: '主人画像',
  private: '私人',
  subject: '对象',
  episode: '情节',
}

// 树上与列表里放不下全名时用的简称
export const layerShortLabels: Record<Layer, string> = {
  base: '基础',
  persona: '人格',
  app: '应用',
  owner: '画像',
  private: '私人',
  subject: '对象',
  episode: '情节',
}

export const sensitivityLabels: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}

// Key 的 admin 在界面上不叫 admin，免得被当成空间管理员
export const ADMIN_SCOPE_LABEL = '跨人格 / 应用写入'

export const accessContextLabels: Record<AccessContext, string> = {
  none: '无上下文（本机 agent）',
  direct: '陌生人私聊',
  owner_direct: '主人私聊',
  group: '群聊',
  cron: '定时任务 / 子 agent',
}

// 权限矩阵里「读得到哪些来源作用域写下的记忆」
export const originScopeLabels: Record<KeyAccessMatrix['contexts'][number]['originScope'], string> =
  {
    any: '不限来源',
    app: '只含全局与本应用写下的',
    group: '只含全局、本应用与本群里写下的',
    direct: '只含全局、本应用与和此人的对话里写下的',
  }

// 召回事件的来路
export const recallSourceLabels: Record<RecallSource, string> = {
  'session.start': '会话开始的项目召回',
  'prompt.submit': '每轮输入',
  'mcp.search': 'MCP 搜索',
  'rest.recall': 'REST 召回',
}

// 召回调试台里一条记忆被这把 Key 过滤掉的原因
export const readDenialLabels: Record<ReadDenial, string> = {
  deleted: '已删除',
  expired: '已失效或过期',
  layer: '这把 Key 读不到这一层',
  sensitivity: '敏感级超出这把 Key 的上限',
  secret: 'secret 只能按 URI 读取，不进召回',
  origin: '来源作用域不在范围内',
  owner: '别的成员的画像或私人层',
  persona: '人格不在这个应用的继承链上',
  app: '别的应用的应用层',
  override: '被继承链上更近的人格的同一路径覆盖',
}

// 按 URI 直接新建时可选的层：persona:// 与 app:// 由 URI 决定，对象与情节层由对话抽取写入
export const creatableLayers: Layer[] = ['base', 'owner', 'private']

export const provenanceLabels: Record<Provenance, string> = {
  owner: '主人',
  agent: 'agent',
  untrusted: '不可信来源',
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
  restore: { label: '恢复到旧版本', icon: icons.restore },
  undelete: { label: '撤销删除', icon: icons.undelete },
  expire: { label: '过期后让出 URI', icon: icons.expired },
}

export function eventLabel(type: string): { label: string; icon: string } {
  return eventLabels[type] ?? { label: type, icon: icons.edit }
}

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

// 活动里「改了哪些字段」
export const changeLabels: Record<string, string> = {
  content: '正文',
  disclosure: 'disclosure',
  priority: 'priority',
  sensitivity: '敏感级',
  layer: '层',
  uri: 'URI',
  glossary: '关键词',
}

export const sensitivityColors: Record<Sensitivity, 'neutral' | 'info' | 'warning' | 'error'> = {
  public: 'neutral',
  internal: 'info',
  private: 'warning',
  secret: 'error',
}

export const providerKindLabels: Record<CredentialProviderKind, string> = {
  bitwarden: 'Bitwarden',
  '1password': '1Password',
  env: '环境变量',
  other: '其他',
}

export const credentialSourceLabels: Record<CredentialSource, string> = {
  hosted: 'Kioku 托管',
  external: '外部凭据源',
}

// 凭据事件：只有凭据的主人看得到，不进空间的活动记录
export const credentialEventLabels: Record<string, { label: string; icon: string }> = {
  create: { label: '新建', icon: icons.add },
  update: { label: '修改', icon: icons.edit },
  delete: { label: '删除', icon: icons.remove },
  undelete: { label: '撤销删除', icon: icons.undelete },
  access: { label: '取用', icon: icons.reveal },
}

// 取用经由哪里
export const credentialViaLabels: Record<string, string> = {
  console: '在管理界面查看',
  kioku_credential: '通过 kioku_credential',
  kioku_get: '读记忆时列出（kioku_get）',
  rest: '通过 REST 接口',
}

export const credentialChangeLabels: Record<string, string> = {
  name: '名称',
  description: '说明',
  source: '来源',
  provider: '凭据源',
  location: '条目位置',
  fields: '字段',
  values: '值',
  appIds: '限定的应用',
}

// 凭据限定给哪些应用，显示成名字。应用列表还没读出来时不下结论；不是自己的应用标出来：
// Key 按应用主人取凭据，别人的应用的 Key 用不了你的凭据
export function restrictedAppsLabel(
  appIds: readonly string[] | null,
  apps: readonly AppInfo[] | undefined,
  me: string | undefined,
): string {
  if (appIds === null) return '不限定'
  if (!appIds.length) return '不给任何应用'
  if (!apps) return '…'
  return appIds
    .map((id) => {
      const app = apps.find((a) => a.id === id)
      if (!app) return '已删除的应用'
      return app.ownerAccountId === me ? app.name : `${app.name}（不是你的应用，用不了）`
    })
    .join('、')
}
