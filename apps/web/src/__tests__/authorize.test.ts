import { DeviceUserCode, formatDeviceUserCode } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import issueKeyModal from '../components/IssueKeyModal.vue?raw'
import keysSettings from '../components/KeysSettings.vue?raw'
import authorizePage from '../pages/AuthorizePage.vue?raw'

describe('浏览器授权与一次性访问密钥弹窗约束', () => {
  it('确认码忽略连字符与空白并统一转大写', () => {
    const parsed = DeviceUserCode.parse(' bcdf-ghjk ')
    expect(parsed).toBe('BCDFGHJK')
    expect(formatDeviceUserCode(parsed)).toBe('BCDF-GHJK')
  })

  it('浏览器授权确认页不再包含记忆圈与权限矩阵，批准按钮不在表单内防止误回车', () => {
    expect(authorizePage).not.toContain('linkedCircles')
    expect(authorizePage).not.toContain('KeyScopeEditor')
    const reviewStart = authorizePage.indexOf("<template v-else-if=\"step === 'review'")
    const approvedStart = authorizePage.indexOf("<template v-else-if=\"step === 'approved'")
    expect(reviewStart).toBeGreaterThan(0)
    expect(approvedStart).toBeGreaterThan(reviewStart)
    const reviewSection = authorizePage.slice(reviewStart, approvedStart)
    expect(reviewSection).not.toContain('<form')
    expect(reviewSection).toContain('@click="approve"')
    expect(reviewSection).toContain('@click="deny"')
  })

  it('签发与轮换访问密钥的一次性明文弹窗禁止误关', () => {
    expect(issueKeyModal).toContain(':dismissible="!saving && !issued"')
    expect(issueKeyModal).toContain(':close="!issued"')
    expect(keysSettings).toContain(':dismissible="false"')
    expect(keysSettings).toContain(':close="false"')
  })
})
