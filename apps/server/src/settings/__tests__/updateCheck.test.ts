import { describe, expect, it } from 'vitest'

import { diagnosticsText, durationText } from '../systemInfo'
import { isNewerRelease, releaseVersion } from '../updateCheck'

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
})

describe('诊断信息', () => {
  it('已运行多久最多写两级', () => {
    expect(durationText(59)).toBe('不到 1 分钟')
    expect(durationText(3 * 3600 + 120)).toBe('3 小时 2 分钟')
    expect(durationText(2 * 86400 + 3600 + 60)).toBe('2 天 1 小时')
    expect(durationText(86400)).toBe('1 天')
  })

  it('不含库名、主机与主密钥标识', () => {
    const text = diagnosticsText({
      build: { version: '0.1.0', commit: 'a'.repeat(40), builtAt: '2026-11-12T00:00:00.000Z' },
      runtime: {
        node: 'v22.0.0',
        platform: 'linux',
        arch: 'arm64',
        osRelease: '6.1.0',
        container: true,
        startedAt: '2026-11-12T00:00:00.000Z',
        uptimeSeconds: 90,
      },
      database: {
        version: '17.2',
        pgvector: '0.8.0',
        zhparser: null,
        migration: '0006_device_grants',
        name: 'hidden_db_name',
        host: 'db.internal.example.com:5432',
      },
      config: {
        masterKey: { configured: true, id: '0123456789abcdef', rotating: true },
        cookieSecure: false,
        trustedProxies: 1,
        webUi: 'served',
        jobs: true,
        embedding: false,
        extraction: true,
      },
      updates: {
        enabled: false,
        applicable: true,
        checkedAt: null,
        failed: false,
        latest: null,
        available: null,
      },
    })
    expect(text).toContain('版本：0.1.0')
    expect(text).toContain('zhparser：未安装')
    expect(text).toContain('主密钥：已配置，轮换中')
    expect(text).toContain('KIOKU_COOKIE_SECURE：false')
    for (const hidden of ['hidden_db_name', 'db.internal.example.com', '0123456789abcdef']) {
      expect(text).not.toContain(hidden)
    }
  })
})
