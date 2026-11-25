import { describe, expect, it } from 'vitest'

import credentialModal from '../components/CredentialModal.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'

describe('凭据管理界面约束', () => {
  it('采用极简托管模型，不包含密码库连接与重型拦截弹窗', () => {
    expect(credentialsPage).not.toContain('VaultConnection')
    expect(credentialsPage).not.toContain('PlaintextSaveModal')
    expect(credentialsPage).toContain('placeholderOf(item.slug)')
    expect(credentialsPage).toContain('<ConsequenceModal')
    expect(credentialModal).not.toContain('<form')
  })

  it('显式查看的凭据明文仅保存在组件局部状态，不写入查询缓存', () => {
    expect(credentialsPage).toContain('api.revealCredential')
    expect(credentialsPage).toContain('revealedValue.value = null')
    expect(credentialsPage).not.toContain('setQueryData')
  })
})
