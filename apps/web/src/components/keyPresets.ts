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
    label: '本机编码 agent',
    help: '读写全部层，最高到私密级。适合 Claude Code、Codex 这类只有主人在用的 agent',
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
    help: '只读共享层（基础、人格、应用、对象、情节），只写对象与情节层，最高公开级。读不到主人的私人信息',
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
    help: '读全部层，最高到私密级，不能写入',
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
