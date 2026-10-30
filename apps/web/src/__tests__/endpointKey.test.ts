import { describe, expect, it } from 'vitest'

import { draftOf } from '../embeddingDrafts'
import { hostOf, needsNewKey, newKeyHint } from '../endpointKey'

const saved = { id: 'c1', baseUrl: 'https://e.example.com/v1', model: 'm', hasApiKey: true }

describe('换了接口主机时密钥要先说怎么处理：嵌入渠道', () => {
  // 换模型时照抄现在的渠道：请求用的模型名留空，Key 留空表示沿用
  const copied = () => ({ ...draftOf(saved), model: '' })

  it('主机变了、Key 留空、也没勾清除：提交之前就拦下', () => {
    expect(needsNewKey({ ...copied(), baseUrl: 'https://other.example.net/v1' })).toBe(true)
    // 端口、协议不同也是别的主机，和服务端沿用 Key 的规则一样
    expect(needsNewKey({ ...copied(), baseUrl: 'https://e.example.com:8443/v1' })).toBe(true)
    expect(needsNewKey({ ...copied(), baseUrl: 'http://e.example.com/v1' })).toBe(true)
  })

  it('填了新的 Key 或勾了清除就行；同一个主机只改路径时沿用已保存的', () => {
    const moved = { ...copied(), baseUrl: 'https://other.example.net/v1' }
    expect(needsNewKey({ ...moved, apiKey: 'sk-new' })).toBe(false)
    expect(needsNewKey({ ...moved, clearKey: true })).toBe(false)
    expect(needsNewKey({ ...copied(), baseUrl: 'https://e.example.com/v2' })).toBe(false)
    expect(needsNewKey({ ...copied(), baseUrl: 'https://E.example.com/v1/' })).toBe(false)
    expect(needsNewKey(copied())).toBe(false)
  })

  it('没有保存 Key 的、新加的渠道不用管；地址还没填成 http 或 https 时先不提示', () => {
    const noKey = { ...draftOf({ ...saved, hasApiKey: false }), baseUrl: 'https://x.example.net' }
    expect(needsNewKey(noKey)).toBe(false)
    expect(needsNewKey({ ...draftOf(), baseUrl: 'https://x.example.net' })).toBe(false)
    expect(needsNewKey({ ...copied(), baseUrl: 'https://' })).toBe(false)
    expect(needsNewKey({ ...copied(), baseUrl: 'ftp://other.example.net/v1' })).toBe(false)
  })
})

describe('换了接口主机时密钥要先说怎么处理：抽取模型与备份', () => {
  // 抽取模型：表单上一个接口，可以清除已保存的 Key
  const extraction = (baseUrl: string, apiKey = '', clearKey = false) => ({
    baseUrl,
    savedBaseUrl: 'https://llm.example.com/v1',
    hasApiKey: true,
    apiKey,
    clearKey,
  })
  // 备份：Secret 不能清除，只能重填
  const backup = (endpoint: string, secret = '', hasSecret = true) => ({
    baseUrl: endpoint,
    savedBaseUrl: hasSecret ? 'https://s3.example.com' : null,
    hasApiKey: hasSecret,
    apiKey: secret,
    clearKey: false,
  })

  it('抽取模型换了主机：要么重填 Key，要么清除', () => {
    expect(needsNewKey(extraction('https://other.example.net/v1'))).toBe(true)
    expect(needsNewKey(extraction('https://other.example.net/v1', 'sk-new'))).toBe(false)
    expect(needsNewKey(extraction('https://other.example.net/v1', '', true))).toBe(false)
    expect(needsNewKey(extraction('https://llm.example.com/v2'))).toBe(false)
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
    expect(newKeyHint('Key', true)).toBe(
      '接口主机变了，已保存的 Key 不会发给新的主机：请重新填写；新接口不需要 Key 时，勾选下面的「清除已保存的 Key」',
    )
    expect(newKeyHint('Secret Access Key', false)).toBe(
      '接口主机变了，已保存的 Secret Access Key 不会发给新的主机：请重新填写',
    )
  })
})
