import { describe, expect, it } from 'vitest'

import { isNewerRelease, releaseVersion, uptimeText, versionLabel } from '../system'

describe('版本比较', () => {
  it('只认 X.Y.Z（可以带 v）', () => {
    expect(releaseVersion('0.1.0')).toEqual([0, 1, 0])
    expect(releaseVersion('v1.2.30')).toEqual([1, 2, 30])
    for (const v of ['dev', 'edge', '70b5d3e-dirty', 'v0.1.0-3-gabc1234', '0.2.0-rc.1', '1.2']) {
      expect(releaseVersion(v)).toBeNull()
    }
  })

  it('逐段按数字比，不按字符串比', () => {
    expect(isNewerRelease('0.10.0', '0.9.9')).toBe(true)
    expect(isNewerRelease('v1.0.0', '0.99.99')).toBe(true)
    expect(isNewerRelease('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerRelease('0.1.0', '0.1.0')).toBe(false)
    expect(isNewerRelease('0.1.0', 'v0.2.0')).toBe(false)
  })

  it('当前不是正式版时不提示', () => {
    for (const current of ['dev', 'edge', '70b5d3e-dirty', 'v0.1.0-3-gabc1234']) {
      expect(isNewerRelease('9.9.9', current)).toBe(false)
    }
  })

  it('正式版前面加 v，别的版本原样', () => {
    expect(versionLabel('0.1.0')).toBe('v0.1.0')
    expect(versionLabel('v0.1.0')).toBe('v0.1.0')
    expect(versionLabel('dev')).toBe('dev')
    expect(versionLabel('70b5d3e-dirty')).toBe('70b5d3e-dirty')
  })
})

describe('已运行多久', () => {
  it('最多写两级', () => {
    expect(uptimeText(59)).toBe('不到 1 分钟')
    expect(uptimeText(3 * 3600 + 120)).toBe('3 小时 2 分钟')
    expect(uptimeText(2 * 86400 + 3600 + 60)).toBe('2 天 1 小时')
    expect(uptimeText(86400)).toBe('1 天')
  })
})
