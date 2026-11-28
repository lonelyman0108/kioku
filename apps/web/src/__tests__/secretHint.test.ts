import { describe, expect, it } from 'vitest'

import { detectSecretPrefixes, findSecretMatches } from '../secretHint'

describe('正文轻量密钥前缀提示', () => {
  it('普通正文与凭据占位符不误报', () => {
    expect(detectSecretPrefixes('')).toEqual([])
    expect(detectSecretPrefixes('连接生产库使用 {{cred:prod-db}}，参考 [[m-ab2345]]')).toEqual([])
    expect(detectSecretPrefixes('sk-short 与 ghp_123 太短不算')).toEqual([])
    expect(findSecretMatches('postgres://user:password@localhost/demo')).toEqual([])
  })

  it('识别常见密钥、私钥、数据库连接串与 Bearer JWT 并给出精准区间', () => {
    // 拼接假前缀样本以避免触发静态扫描误报
    const jwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${'eyJzdWIiOiJ1c2VyXzQ5MjEiLCJzY29wZSI6ImFkbWluIn0'}.${'K7xQwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw9z'}`
    const cases: [string, string][] = [
      [['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nabc'].join(' '), '私钥块'],
      [`export AWS_ACCESS_KEY_ID=${'AKIA'}${'IOSFODNN7EXAMPLE'}`, 'AWS 访问凭证'],
      [`token = ${'ghp_'}${'a'.repeat(24)}`, 'GitHub 令牌'],
      [`token = ${'github_pat_'}${'a'.repeat(24)}`, 'GitHub 令牌'],
      [`SLACK=${'xoxb-'}${'1234567890'}-${'abcdefghij'}`, 'Slack 令牌'],
      [`OPENAI_KEY=${'sk-proj-'}${'a'.repeat(24)}`, 'OpenAI / 服务密钥'],
      [`ANTHROPIC=${'sk-ant-'}${'a'.repeat(24)}`, 'Anthropic 密钥'],
      [`KIOKU=${'kioku_'}${'a'.repeat(20)}`, 'Kioku 访问密钥'],
      [
        `DATABASE_URL=postgres://svc_app:${'R3alStr0ngPass9'}@db.prod.internal:5432/prod`,
        '数据库连接串',
      ],
      [`Authorization: Bearer ${jwt}`, 'Bearer JWT 令牌'],
    ]
    for (const [sample, expectedLabel] of cases) {
      const hits = findSecretMatches(sample)
      const hit = hits.find((h) => h.label === expectedLabel)
      expect(hit, sample).toBeDefined()
      expect(sample.slice(hit!.start, hit!.end)).toBe(hit!.match)
    }
  })
})
