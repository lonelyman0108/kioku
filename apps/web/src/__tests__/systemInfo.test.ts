import type { UpdateCheckView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { commitUrl, shortCommit, updateStatus, uptimeText, versionLabel } from '../systemInfo'

const sha = '70b5d3e5b6f712b449b8d0b36c7a52ba326eae42'
const updates = (patch: Partial<UpdateCheckView> = {}): UpdateCheckView => ({
  enabled: true,
  applicable: true,
  checkedAt: '2026-11-12T00:00:00.000Z',
  failed: false,
  latest: '0.1.0',
  available: null,
  ...patch,
})

describe('系统信息', () => {
  it('提交写短 id，链接到 GitHub；没有提交时不给链接', () => {
    expect(shortCommit(sha)).toBe('70b5d3e')
    expect(commitUrl(sha)).toBe(`https://github.com/lonelyman0108/kioku/commit/${sha}`)
    expect(shortCommit(null)).toBeNull()
    expect(commitUrl(null)).toBeNull()
    expect(commitUrl('../../evil')).toBeNull()
  })

  it('正式版前面加 v，别的版本原样', () => {
    expect(versionLabel('0.1.0')).toBe('v0.1.0')
    expect(versionLabel('dev')).toBe('dev')
    expect(versionLabel('70b5d3e-dirty')).toBe('70b5d3e-dirty')
  })

  it('已运行多久最多写两级', () => {
    expect(uptimeText(30)).toBe('不到 1 分钟')
    expect(uptimeText(125 * 60)).toBe('2 小时 5 分钟')
    expect(uptimeText(3 * 86400 + 7200)).toBe('3 天 2 小时')
  })

  it('检查新版本的状态', () => {
    expect(updateStatus(updates({ enabled: false }))).toBe('已关闭')
    expect(updateStatus(updates({ applicable: false }))).toBe('当前不是正式版，不检查')
    expect(updateStatus(updates({ checkedAt: null }))).toBe('尚未检查')
    expect(
      updateStatus(updates({ latest: '0.2.0', available: { version: '0.2.0', url: 'x' } })),
    ).toBe('有新版本 v0.2.0')
    expect(updateStatus(updates({ failed: true }))).toBe('上次检查失败')
    expect(updateStatus(updates())).toBe('已是最新')
    expect(updateStatus(updates({ latest: null }))).toBe('暂无正式版')
  })
})
