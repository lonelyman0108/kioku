import type { CredentialEvent, KeyScopes, VaultConnection } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import appKeys from '../components/AppKeys.vue?raw'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import credentialForm from '../components/CredentialFormModal.vue?raw'
import keyMatrix from '../components/KeyMatrix.vue?raw'
import {
  allowedCredentialCapability,
  issuedCredentialCapability,
  keyPresets,
  sameScopes,
} from '../components/keyPresets'
import { scopesSummary } from '../labels'
import {
  canManageCredentials,
  collectionNames,
  connectionStatusText,
  credentialEventParts,
  disconnectNotice,
  itemFieldLabel,
  itemsAvailable,
  suggestIdentifier,
  vaultCredentialDraft,
} from '../vault'

const event = (over: Partial<CredentialEvent> = {}): CredentialEvent => ({
  id: 1,
  type: 'access',
  createdAt: '2026-11-07T00:00:00Z',
  actor: { accountName: null, keyName: 'MacBook', appName: 'Claude Code' },
  via: null,
  fields: [],
  purpose: null,
  result: null,
  reason: null,
  chatType: null,
  changes: [],
  bench: null,
  ...over,
})

describe('条目字段的显示名', () => {
  it('固定字段用中文名，自定义字段显示原名', () => {
    expect(itemFieldLabel('login.username')).toBe('用户名')
    expect(itemFieldLabel('login.password')).toBe('密码')
    expect(itemFieldLabel('login.totp')).toBe('TOTP')
    expect(itemFieldLabel('notes')).toBe('备注')
    expect(itemFieldLabel('field:API Token')).toBe('API Token')
  })
})

describe('起标识的预填', () => {
  const item = {
    name: '  NAS 管理后台 ',
    fields: ['login.username', 'login.password', 'login.totp', 'field:Admin PIN', 'notes'],
  }

  it('字段对应用 defaultCredentialFields 推出，名称取条目名称', () => {
    const draft = vaultCredentialDraft(item, [])
    expect(draft.name).toBe('NAS 管理后台')
    expect(draft.fields).toEqual([
      { name: 'username', itemField: 'login.username' },
      { name: 'password', itemField: 'login.password' },
      { name: 'totp', itemField: 'login.totp' },
      { name: 'admin-pin', itemField: 'field:Admin PIN' },
      { name: 'notes', itemField: 'notes' },
    ])
  })

  it('建议的标识避开已有的；拼不出时留空', () => {
    expect(vaultCredentialDraft(item, []).identifier).toBe('nas')
    expect(vaultCredentialDraft(item, ['nas']).identifier).toBe('nas-2')
    expect(suggestIdentifier('File Server', ['file-server', 'file-server-2'])).toBe('file-server-3')
    expect(suggestIdentifier('文件服务器', [])).toBe('')
  })

  it('名称超出上限时截断', () => {
    expect(vaultCredentialDraft({ name: 'x'.repeat(120), fields: [] }, []).name).toHaveLength(100)
  })
})

describe('连接', () => {
  const conn = (over: Partial<VaultConnection> = {}): VaultConnection => ({
    id: '00000000-0000-4000-8000-000000000001',
    serverUrl: 'https://vault.example.com',
    email: 'agent@example.com',
    status: 'ok',
    disabledReason: null,
    lastError: null,
    lastCheckedAt: null,
    disconnectedAt: null,
    credentialCount: 0,
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    ...over,
  })

  it('状态：已停用的带上原因', () => {
    expect(connectionStatusText(conn())).toBe('可用')
    expect(connectionStatusText(conn({ status: 'reauth_required' }))).toBe('需要重新登录')
    expect(connectionStatusText(conn({ status: 'disconnected' }))).toBe('已断开')
    expect(
      connectionStatusText(conn({ status: 'disabled', disabledReason: 'personal_items' })),
    ).toBe('已停用：有个人条目')
    expect(
      connectionStatusText(conn({ status: 'disabled', disabledReason: 'organization_role' })),
    ).toBe('已停用：组织角色为所有者或管理员')
  })

  it('只有可用的连接列条目', () => {
    expect(itemsAvailable(conn())).toBe(true)
    for (const status of ['reauth_required', 'disabled', 'disconnected'] as const) {
      expect(itemsAvailable(conn({ status }))).toBe(false)
    }
  })

  it('断开的确认文字：结果、影响、动作', () => {
    const text = disconnectNotice(conn({ credentialCount: 3 }))
    expect(text).toBe(
      '断开后，保存的令牌与密钥立即清除，指向它的 3 条凭据将无法取值。重新登录同一账号可恢复。',
    )
    expect(disconnectNotice(conn())).toContain('指向它的凭据将无法取值。')
  })

  it('集合按名字列出，列表里没有的不列', () => {
    const list = {
      collections: [
        { id: 'c1', organizationId: 'o1', name: 'Agent' },
        { id: 'c2', organizationId: 'o1', name: '运维' },
      ],
    }
    const item = {
      id: 'i1',
      organizationId: 'o1',
      collectionIds: ['c2', 'gone', 'c1'],
      name: 'NAS',
      type: 'login' as const,
      fields: [],
      revisionDate: '2026-11-07T00:00:00Z',
      credential: null,
    }
    expect(collectionNames(item, list)).toEqual(['运维', 'Agent'])
  })

  it('凭据与连接的操作只给空间所有者', () => {
    expect(canManageCredentials('owner')).toBe(true)
    expect(canManageCredentials('editor')).toBe(false)
    expect(canManageCredentials('viewer')).toBe(false)
    expect(canManageCredentials(undefined)).toBe(false)
  })
})

describe('访问记录', () => {
  it('取用：结果与原因、经由、会话上下文、用途、字段，中文名用 names.ts 的', () => {
    expect(
      credentialEventParts(
        event({
          via: 'kioku_credential',
          result: 'denied',
          reason: 'context',
          chatType: 'group',
          purpose: '部署 NAS',
          fields: ['password'],
        }),
      ),
    ).toEqual([
      '被拒：会话上下文不允许',
      '通过 kioku_credential',
      '会话上下文：群聊',
      '用途：部署 NAS',
      '字段 password',
    ])
  })

  it('成功的不带原因；失败的带密码库的原因', () => {
    expect(credentialEventParts(event({ via: 'run', result: 'ok', chatType: 'none' }))).toEqual([
      '成功',
      '通过 kioku run',
      '会话上下文：无上下文（本机 Agent）',
    ])
    expect(
      credentialEventParts(event({ via: 'console', result: 'failed', reason: 'item_unavailable' })),
    ).toEqual(['失败：条目不可用', '在管理界面查看'])
    expect(credentialEventParts(event({ via: 'space_export', result: 'ok' }))).toEqual([
      '成功',
      '随空间导出',
    ])
  })

  it('修改：列出改了哪些部分；不认识的原样显示', () => {
    expect(
      credentialEventParts(event({ type: 'update', changes: ['fields', 'appIds', 'other'] })),
    ).toEqual(['修改了字段对应、限定的应用、other'])
    expect(credentialEventParts(event({ via: 'mystery', chatType: 'weird' }))).toEqual([
      'mystery',
      '会话上下文：weird',
    ])
  })
})

describe('凭据能力', () => {
  const base: KeyScopes = {
    readLayers: ['core', 'user'],
    writeLayers: ['user'],
    maxSensitivity: 'private',
    admin: false,
    credentials: 'none',
  }

  it('不是空间所有者时只能选不可用', () => {
    expect(allowedCredentialCapability('use', true)).toBe('use')
    expect(allowedCredentialCapability('manage', true)).toBe('manage')
    expect(allowedCredentialCapability('use', false)).toBe('none')
    expect(allowedCredentialCapability('manage', false)).toBe('none')
  })

  it('本机 Agent 预选取用，群聊机器人与只读不可用', () => {
    const of = (id: string) => keyPresets.find((p) => p.id === id)!.scopes.credentials
    expect(of('agent')).toBe('use')
    expect(of('bot')).toBe('none')
    expect(of('readonly')).toBe('none')
  })

  it('签发范围不够时，实际能用到的档位往下收', () => {
    expect(issuedCredentialCapability({ ...base, credentials: 'manage' })).toBe('manage')
    expect(issuedCredentialCapability({ ...base, credentials: 'manage', writeLayers: [] })).toBe(
      'use',
    )
    expect(
      issuedCredentialCapability({ ...base, credentials: 'use', maxSensitivity: 'internal' }),
    ).toBe('none')
    expect(issuedCredentialCapability({ ...base, credentials: 'use', readLayers: ['core'] })).toBe(
      'none',
    )
  })

  it('凭据能力不同就不是同一组权限，概括里写出来', () => {
    expect(sameScopes(base, { ...base, credentials: 'use' })).toBe(false)
    expect(scopesSummary({ ...base, credentials: 'use' })).toContain('凭据取用')
    expect(scopesSummary(base)).not.toContain('凭据')
  })
})

describe('界面用上了这些规则', () => {
  it('签发访问密钥：选项与预设都按空间所有者收紧', () => {
    expect(appKeys).toContain('disabled: allowedCredentialCapability(c, props.isSpaceOwner) !== c')
    expect(appKeys).toContain(
      'credentials: allowedCredentialCapability(credentials, props.isSpaceOwner)',
    )
    expect(appKeys).toContain('<URadioGroup v-model="form.scopes.credentials"')
  })

  it('权限范围按接口给的会话上下文显示凭据能力', () => {
    expect(keyMatrix).toContain('credentialCapabilityLabels[current.credentials]')
  })

  it('起标识的表单按 vaultCredentialDraft 预填', () => {
    expect(credentialForm).toContain('vaultCredentialDraft(item.item, props.identifiers)')
  })

  it('查看的值只放在详情组件里，不进查询缓存', () => {
    expect(credentialDetail).toContain('const revealed = ref<Record<string, string> | null>(null)')
    expect(credentialDetail).not.toContain('setQueryData')
  })
})
