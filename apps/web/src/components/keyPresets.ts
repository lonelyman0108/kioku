import {
  ENTRY_KINDS,
  SENSITIVITIES,
  type CredentialCapability,
  type EntryKind,
  type LensKeyScopes,
} from '@kioku/contracts'

export interface KeyPreset {
  id: string
  label: string
  // 卡片上的一句适用说明
  help: string
  scopes: LensKeyScopes
}

// 不和任何模板一样时选中的卡片
export const CUSTOM_PRESET = 'custom'
export const CUSTOM_PRESET_HELP = '逐项勾选下面的表格'

// 签发访问密钥时的常用组合，与设计里的透镜授权模型对应；表格里改了任何一格就按 matchPreset 重新对
export const keyPresets: KeyPreset[] = [
  {
    id: 'agent',
    label: '本机编码 Agent',
    help: 'Claude Code、Codex 等仅本人使用',
    scopes: {
      readKinds: [...ENTRY_KINDS],
      writeKinds: [...ENTRY_KINDS],
      maxSensitivity: 'private',
      allowedRealms: null,
      admin: false,
      credentials: 'use',
    },
  },
  {
    id: 'bot',
    label: '群聊机器人',
    help: '面向他人，仅写联系人事实与会话摘要',
    scopes: {
      readKinds: [...ENTRY_KINDS],
      writeKinds: ['fact', 'episode'],
      maxSensitivity: 'public',
      allowedRealms: null,
      admin: false,
      credentials: 'none',
    },
  },
  {
    id: 'readonly',
    label: '只读',
    help: '检索与预览，不可写入',
    scopes: {
      readKinds: [...ENTRY_KINDS],
      writeKinds: [],
      maxSensitivity: 'private',
      allowedRealms: null,
      admin: false,
      credentials: 'none',
    },
  },
]

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...new Set(a)].sort()
  const sb = [...new Set(b)].sort()
  return sa.length === sb.length && sa.every((v, i) => v === sb[i])
}

// 两组透镜权限是否相同（物种与场域集合的元素先后不算，区分 allowedRealms 的 null 与数组）
export function sameScopes(a: LensKeyScopes, b: LensKeyScopes): boolean {
  const realmsEqual =
    a.allowedRealms === null || b.allowedRealms === null
      ? a.allowedRealms === b.allowedRealms
      : sameStringSet(a.allowedRealms, b.allowedRealms)
  return (
    a.maxSensitivity === b.maxSensitivity &&
    a.admin === b.admin &&
    a.credentials === b.credentials &&
    realmsEqual &&
    sameStringSet(a.readKinds, b.readKinds) &&
    sameStringSet(a.writeKinds, b.writeKinds)
  )
}

// 签发时能选的凭据能力：只有记忆圈所有者的接入实例能有取用与管理，别的成员只能选不可用
export function allowedCredentialCapability(
  capability: CredentialCapability,
  isCircleOwner: boolean,
): CredentialCapability {
  return isCircleOwner ? capability : 'none'
}

// 按签发范围，凭据能力实际能用到哪一档：与服务端 credentialDenial 对齐。
// 取用与管理都需要可读正式词条且最高敏感级不低于私密；管理另需可写正式词条。
export function issuedCredentialCapability(scopes: LensKeyScopes): CredentialCapability {
  if (scopes.credentials === 'none') return 'none'
  const canReadEntries =
    scopes.readKinds.includes('entry') &&
    SENSITIVITIES.indexOf(scopes.maxSensitivity) >= SENSITIVITIES.indexOf('private')
  if (!canReadEntries) return 'none'
  if (scopes.credentials === 'manage' && !scopes.writeKinds.includes('entry')) return 'use'
  return scopes.credentials
}

function cloneScopes(scopes: LensKeyScopes): LensKeyScopes {
  return {
    readKinds: [...scopes.readKinds] as EntryKind[],
    writeKinds: [...scopes.writeKinds] as EntryKind[],
    maxSensitivity: scopes.maxSensitivity,
    allowedRealms: scopes.allowedRealms === null ? null : [...scopes.allowedRealms],
    admin: scopes.admin,
    credentials: scopes.credentials,
  }
}

// 模板按签发人收紧之后的权限：不是记忆圈所有者时凭据能力只能是不可用
export function presetScopes(preset: KeyPreset, isCircleOwner: boolean): LensKeyScopes {
  const copy = cloneScopes(preset.scopes)
  return {
    ...copy,
    credentials: allowedCredentialCapability(copy.credentials, isCircleOwner),
  }
}

// 凭据能力的适用条件，签发弹窗与浏览器授权确认页共用这一句
export const CREDENTIAL_CAPABILITY_HINT =
  '取用与管理都需要可读正式词条、最高敏感级不低于私密，管理还需要可写正式词条。带会话上下文（群聊、私聊、定时任务）或客场圈时凭据一律不可用。'

// 签发范围按签发人收紧：不是记忆圈所有者时，凭据能力、机密级与管理词表及人格权限都不能带着
export function tightenScopes(scopes: LensKeyScopes, isCircleOwner: boolean): LensKeyScopes {
  const copy = cloneScopes(scopes)
  return {
    ...copy,
    credentials: allowedCredentialCapability(copy.credentials, isCircleOwner),
    maxSensitivity:
      !isCircleOwner && copy.maxSensitivity === 'secret' ? 'private' : copy.maxSensitivity,
    admin: isCircleOwner && copy.admin,
  }
}

// 当前的签发范围和哪个模板完全一样（按签发人收紧之后比），都不一样时是自定义
export function matchPreset(scopes: LensKeyScopes, isCircleOwner: boolean): string {
  return (
    keyPresets.find((p) => sameScopes(scopes, presetScopes(p, isCircleOwner)))?.id ?? CUSTOM_PRESET
  )
}
