import type { EventActor, Layer, Provenance, Sensitivity } from '@kioku/contracts'

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
