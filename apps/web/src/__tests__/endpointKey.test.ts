import { describe, expect, it } from 'vitest'

import { hostOf, needsNewKey, newKeyHint } from '../endpointKey'

describe('换了接口主机时密钥要先说怎么处理：模型服务商', () => {
  const provider = (baseUrl: string, apiKey = '', clearKey = false) => ({
    baseUrl,
    savedBaseUrl: 'https://e.example.com/v1',
    hasApiKey: true,
    apiKey,
    clearKey,
  })

  it('主机变了、Key 留空、也没勾清除：提交之前就拦下', () => {
    expect(needsNewKey(provider('https://other.example.net/v1'))).toBe(true)
    expect(needsNewKey(provider('https://e.example.com:8443/v1'))).toBe(true)
    expect(needsNewKey(provider('http://e.example.com/v1'))).toBe(true)
  })

  it('填了新的 Key 或勾了清除就行；同一个主机只改路径时沿用已保存的', () => {
    expect(needsNewKey(provider('https://other.example.net/v1', 'sk-new'))).toBe(false)
    expect(needsNewKey(provider('https://other.example.net/v1', '', true))).toBe(false)
    expect(needsNewKey(provider('https://e.example.com/v2'))).toBe(false)
    expect(needsNewKey(provider('https://E.example.com/v1/'))).toBe(false)
    expect(needsNewKey(provider('https://e.example.com/v1'))).toBe(false)
  })

  it('没有保存 Key 的、新加的服务商不用管；地址还没填成 http 或 https 时先不提示', () => {
    expect(
      needsNewKey({
        baseUrl: 'https://x.example.net',
        savedBaseUrl: 'https://e.example.com/v1',
        hasApiKey: false,
        apiKey: '',
        clearKey: false,
      }),
    ).toBe(false)
    expect(
      needsNewKey({
        baseUrl: 'https://x.example.net',
        savedBaseUrl: null,
        hasApiKey: false,
        apiKey: '',
        clearKey: false,
      }),
    ).toBe(false)
    expect(needsNewKey(provider('https://'))).toBe(false)
    expect(needsNewKey(provider('ftp://other.example.net/v1'))).toBe(false)
  })
})

describe('换了接口主机时密钥要先说怎么处理：备份', () => {
  const backup = (endpoint: string, secret = '', hasSecret = true) => ({
    baseUrl: endpoint,
    savedBaseUrl: hasSecret ? 'https://s3.example.com' : null,
    hasApiKey: hasSecret,
    apiKey: secret,
    clearKey: false,
  })

  it('备份换了接口主机：只有重填 Secret 才行；还没保存过 Secret 时不用管', () => {
    expect(needsNewKey(backup('https://minio.example.net'))).toBe(true)
    expect(needsNewKey(backup('https://minio.example.net', 'new-secret'))).toBe(false)
    expect(needsNewKey(backup('https://s3.example.com/'))).toBe(false)
    expect(needsNewKey(backup('https://minio.example.net', '', false))).toBe(false)
  })

  it('主机按协议、主机名与端口算，只认 http 与 https', () => {
    expect(hostOf('https://Store.example.com:443/path?x=1')).toBe('https://store.example.com')
    expect(hostOf('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000')
    expect(hostOf('ftp://s3.example.com')).toBeNull()
    expect(hostOf('s3.example.com')).toBeNull()
  })

  it('说明对着界面上的说法：能清除的提清除那个勾选框，不能清除的只说重填', () => {
    expect(newKeyHint('API Key', true)).toBe(
      '接口主机已更改，已保存的 API Key 不会发送到新主机。请重新填写；新接口不需要 API Key 时，请勾选下方的「清除已保存的 API Key」。',
    )
    expect(newKeyHint('Secret Access Key', false)).toBe(
      '接口主机已更改，已保存的 Secret Access Key 不会发送到新主机。请重新填写。',
    )
  })
})
