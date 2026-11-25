import { describe, expect, it } from 'vitest'

import { detectSecretPrefixes } from '../secretHint'

describe('正文轻量密钥前缀提示', () => {
  it('普通正文与凭据占位符不误报', () => {
    expect(detectSecretPrefixes('')).toEqual([])
    expect(detectSecretPrefixes('连接生产库使用 {{cred:prod-db}}，参考 [[m-ab2345]]')).toEqual([])
    expect(detectSecretPrefixes('sk-short 与 ghp_123 太短不算')).toEqual([])
  })

  it('识别常见密钥与私钥前缀', () => {
    // 拼接假前缀样本以避免触发静态扫描误报
    const cases: [string, string][] = [
      [['-----BEGIN OPENSSH', 'PRIVATE KEY-----\nabc'].join(' '), '私钥块'],
      [`export AWS_ACCESS_KEY_ID=${'AKIA'}${'IOSFODNN7EXAMPLE'}`, 'AWS 访问凭证'],
      [`token = ${'ghp_'}${'a'.repeat(24)}`, 'GitHub 令牌'],
      [`token = ${'github_pat_'}${'a'.repeat(24)}`, 'GitHub 令牌'],
      [`SLACK=${'xoxb-'}${'1234567890'}-${'abcdefghij'}`, 'Slack 令牌'],
      [`OPENAI_KEY=${'sk-proj-'}${'a'.repeat(24)}`, 'OpenAI / 服务密钥'],
      [`ANTHROPIC=${'sk-ant-'}${'a'.repeat(24)}`, 'Anthropic 密钥'],
      [`KIOKU=${'kioku_'}${'a'.repeat(20)}`, 'Kioku 访问密钥'],
    ]
    for (const [sample, expectedLabel] of cases) {
      const hits = detectSecretPrefixes(sample)
      expect(
        hits.some((h) => h.label === expectedLabel),
        sample,
      ).toBe(true)
    }
  })
})
