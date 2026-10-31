import { LAYERS, type KeyScopes, type Layer } from '@kioku/contracts'

export interface KeyPreset {
  id: string
  label: string
  help: string
  scopes: KeyScopes
}

const shared: Layer[] = ['base', 'persona', 'app', 'subject', 'episode']

// 签发 Key 时的常用组合，与设计里的分层授权对应；高级模式可以逐项调整
export const keyPresets: KeyPreset[] = [
  {
    id: 'agent',
    label: '本机编码 Agent',
    help: '读写全部层，最高至私密级。适用于 Claude Code、Codex 等仅本人使用的 Agent',
    scopes: {
      readLayers: [...LAYERS],
      writeLayers: [...LAYERS],
      maxSensitivity: 'private',
      admin: false,
    },
  },
  {
    id: 'bot',
    label: '群聊机器人',
    help: '仅读取共享层（基础、人格、应用、联系人、情节），仅写入联系人层与情节层，最高至公开级。无法读取所有者的私人信息',
    scopes: {
      readLayers: shared,
      writeLayers: ['subject', 'episode'],
      maxSensitivity: 'public',
      admin: false,
    },
  },
  {
    id: 'readonly',
    label: '只读',
    help: '读取全部层，最高至私密级，不可写入',
    scopes: { readLayers: [...LAYERS], writeLayers: [], maxSensitivity: 'private', admin: false },
  },
]

// 两组权限是否相同（层的先后不算）
export function sameScopes(a: KeyScopes, b: KeyScopes): boolean {
  const same = (x: Layer[], y: Layer[]) => x.length === y.length && x.every((l) => y.includes(l))
  return (
    a.maxSensitivity === b.maxSensitivity &&
    a.admin === b.admin &&
    same(a.readLayers, b.readLayers) &&
    same(a.writeLayers, b.writeLayers)
  )
}
