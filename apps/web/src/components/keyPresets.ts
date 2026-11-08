import {
  LAYERS,
  SENSITIVITIES,
  type CredentialCapability,
  type KeyScopes,
  type Layer,
} from '@kioku/contracts'

export interface KeyPreset {
  id: string
  label: string
  // 卡片上的一句适用说明
  help: string
  scopes: KeyScopes
}

// 不和任何模板一样时选中的卡片
export const CUSTOM_PRESET = 'custom'
export const CUSTOM_PRESET_HELP = '逐项勾选下面的表格'

const shared: Layer[] = ['core', 'persona', 'app', 'subject', 'episode']

// 签发 Key 时的常用组合，与设计里的授权表对应；表格里改了任何一格就按 matchPreset 重新对
export const keyPresets: KeyPreset[] = [
  {
    id: 'agent',
    label: '本机编码 Agent',
    help: 'Claude Code、Codex 等仅本人使用',
    scopes: {
      readLayers: [...LAYERS],
      writeLayers: [...LAYERS],
      maxSensitivity: 'private',
      admin: false,
      credentials: 'use',
    },
  },
  {
    id: 'bot',
    label: '群聊机器人',
    help: '面向他人，不含所有者的本人记忆',
    scopes: {
      readLayers: shared,
      writeLayers: ['subject', 'episode'],
      maxSensitivity: 'public',
      admin: false,
      credentials: 'none',
    },
  },
  {
    id: 'readonly',
    label: '只读',
    help: '检索与预览，不可写入',
    scopes: {
      readLayers: [...LAYERS],
      writeLayers: [],
      maxSensitivity: 'private',
      admin: false,
      credentials: 'none',
    },
  },
]

// 两组权限是否相同（归属的先后不算）
export function sameScopes(a: KeyScopes, b: KeyScopes): boolean {
  const same = (x: Layer[], y: Layer[]) => x.length === y.length && x.every((l) => y.includes(l))
  return (
    a.maxSensitivity === b.maxSensitivity &&
    a.admin === b.admin &&
    a.credentials === b.credentials &&
    same(a.readLayers, b.readLayers) &&
    same(a.writeLayers, b.writeLayers)
  )
}

// 签发时能选的凭据能力：只有空间所有者的应用能有取用与管理，别的成员只能选不可用（服务端按角色同样收紧）
export function allowedCredentialCapability(
  capability: CredentialCapability,
  isSpaceOwner: boolean,
): CredentialCapability {
  return isSpaceOwner ? capability : 'none'
}

// 按签发范围，凭据能力实际能用到哪一档：取用与管理都要能读本人、最高敏感级不低于私密，管理还要能写本人。
// 只用于签发时的预览；签发之后看权限范围（接口按会话上下文算）
export function issuedCredentialCapability(scopes: KeyScopes): CredentialCapability {
  if (scopes.credentials === 'none') return 'none'
  const readsUser =
    scopes.readLayers.includes('user') &&
    SENSITIVITIES.indexOf(scopes.maxSensitivity) >= SENSITIVITIES.indexOf('private')
  if (!readsUser) return 'none'
  if (scopes.credentials === 'manage' && !scopes.writeLayers.includes('user')) return 'use'
  return scopes.credentials
}

// 模板按签发人收紧之后的权限：不是空间所有者时凭据能力只能是不可用，卡片上和选中后都是这一份
export function presetScopes(preset: KeyPreset, isSpaceOwner: boolean): KeyScopes {
  return {
    ...preset.scopes,
    readLayers: [...preset.scopes.readLayers],
    writeLayers: [...preset.scopes.writeLayers],
    credentials: allowedCredentialCapability(preset.scopes.credentials, isSpaceOwner),
  }
}

// 当前的签发范围和哪个模板完全一样（按签发人收紧之后比），都不一样时是自定义
export function matchPreset(scopes: KeyScopes, isSpaceOwner: boolean): string {
  return (
    keyPresets.find((p) => sameScopes(scopes, presetScopes(p, isSpaceOwner)))?.id ?? CUSTOM_PRESET
  )
}
