import type { CredentialMeta } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  credentialSearchSuffix,
  matchCredentialsForSearch,
  SETTINGS_SUBPAGES,
} from '../composables/useConsoleSearch'
import consoleSearchSource from '../composables/useConsoleSearch.ts?raw'

function makeCred(
  overrides: Partial<CredentialMeta> & { slug: string; label: string },
): CredentialMeta {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    description: null,
    kind: 'secret',
    primaryField: 'value',
    fieldMeta: [{ name: 'value', label: '值', secret: true }],
    passkeyManualOnly: false,
    provider: 'builtin',
    externalRef: null,
    allowedRealms: ['work'],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }
}

const sampleCreds: CredentialMeta[] = [
  makeCred({
    slug: 'prod-db',
    label: '生产数据库',
    description: '主库连接与只读账号',
    kind: 'database',
    primaryField: 'url',
    fieldMeta: [
      { name: 'url', label: '连接串', secret: true },
      { name: 'host', label: '主机', secret: false },
      { name: 'password', label: '密码', secret: true },
    ],
  }),
  makeCred({
    slug: 'github-pat',
    label: 'GitHub 发布令牌',
    description: '用于推送版本标签',
    kind: 'api',
    primaryField: 'token',
    fieldMeta: [
      { name: 'endpoint', label: '接口地址', secret: false },
      { name: 'token', label: '访问令牌', secret: true },
    ],
  }),
  makeCred({
    slug: 'ops-ssh',
    label: '跳板机 SSH',
    kind: 'ssh',
    primaryField: 'private_key',
    fieldMeta: [
      { name: 'username', label: '用户名', secret: false },
      { name: 'private_key', label: '私钥', secret: true, multiline: true },
    ],
  }),
]

describe('全局命令面板搜索与凭据元数据匹配', () => {
  it('设置子页包含全部六项子视图与浏览器授权入口', () => {
    const labels = SETTINGS_SUBPAGES.map((item) => item.label)
    expect(labels).toEqual([
      '设置 · 终端与密钥',
      '设置 · 嵌入与索引',
      '设置 · 对话与整理',
      '设置 · 定时计划',
      '设置 · 账号与登录设备',
      '设置 · 备份与迁移',
      '浏览器授权',
    ])
  })

  it('仅匹配凭据元数据（label、slug、description 与 fieldMeta），绝不调用 reveal 解密', () => {
    expect(consoleSearchSource).not.toContain('revealCredential')
    expect(consoleSearchSource).toContain('api.credentials()')
    expect(consoleSearchSource).toContain('newCredentialRoute')

    expect(matchCredentialsForSearch(sampleCreds, '')).toEqual([])
    expect(matchCredentialsForSearch(sampleCreds, '   ')).toEqual([])

    // 命中 slug
    const bySlug = matchCredentialsForSearch(sampleCreds, 'github')
    expect(bySlug.map((m) => m.cred.slug)).toEqual(['github-pat'])
    expect(credentialSearchSuffix(bySlug[0]!)).toBe('github-pat · 用于推送版本标签')

    // 命中 label
    const byLabel = matchCredentialsForSearch(sampleCreds, '生产数据库')
    expect(byLabel.map((m) => m.cred.slug)).toEqual(['prod-db'])

    // 命中 description
    const byDesc = matchCredentialsForSearch(sampleCreds, '只读账号')
    expect(byDesc.map((m) => m.cred.slug)).toEqual(['prod-db'])

    // 命中 fieldMeta.name 或 fieldMeta.label 时后缀提示 slug#field
    const byFieldName = matchCredentialsForSearch(sampleCreds, 'private_key')
    expect(byFieldName).toHaveLength(1)
    expect(byFieldName[0]!.cred.slug).toBe('ops-ssh')
    expect(credentialSearchSuffix(byFieldName[0]!)).toBe('ops-ssh#private_key · 私钥')

    const byFieldLabel = matchCredentialsForSearch(sampleCreds, '连接串')
    expect(byFieldLabel).toHaveLength(1)
    expect(credentialSearchSuffix(byFieldLabel[0]!)).toBe('prod-db#url · 连接串')

    // 直接搜索 slug#field
    const byComposite = matchCredentialsForSearch(sampleCreds, 'prod-db#pass')
    expect(byComposite).toHaveLength(1)
    expect(credentialSearchSuffix(byComposite[0]!)).toBe('prod-db#password · 密码')
  })
})
