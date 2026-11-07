import { describe, expect, it } from 'vitest'

import {
  CredentialIdentifierQuery,
  defaultCredentialFields,
  isVaultFieldRef,
  KeyScopes,
  VaultServerUrl,
} from '../index'

describe('密码库来源的字段', () => {
  it('认得出条目里的字段写法', () => {
    for (const ref of [
      'login.username',
      'login.password',
      'login.totp',
      'notes',
      'field:API Key',
    ]) {
      expect(isVaultFieldRef(ref), ref).toBe(true)
    }
    for (const ref of [
      'login.uris',
      'field:',
      'field:a\nb',
      'password',
      `field:${'x'.repeat(201)}`,
    ]) {
      expect(isVaultFieldRef(ref), ref).toBe(false)
    }
  })

  it('按条目里的字段推出字段名：固定字段取固定的名字，自定义字段不合规时另起', () => {
    expect(
      defaultCredentialFields([
        'field:Password',
        'login.username',
        'login.password',
        'login.totp',
        'notes',
        'field:api_key',
        'field:API Key',
        'field:密钥',
        'field:令牌',
        'login.uris',
      ]),
    ).toEqual([
      { name: 'password-2', itemField: 'field:Password' },
      { name: 'username', itemField: 'login.username' },
      { name: 'password', itemField: 'login.password' },
      { name: 'totp', itemField: 'login.totp' },
      { name: 'notes', itemField: 'notes' },
      { name: 'api_key', itemField: 'field:api_key' },
      { name: 'api-key', itemField: 'field:API Key' },
      { name: 'field', itemField: 'field:密钥' },
      { name: 'field-2', itemField: 'field:令牌' },
    ])
  })

  it('同一个字段只出现一次', () => {
    expect(defaultCredentialFields(['notes', 'notes'])).toEqual([
      { name: 'notes', itemField: 'notes' },
    ])
  })
})

describe('服务器地址', () => {
  it('收 https，本机回环地址与不带点的主机名也收 http；去掉末尾的 /', () => {
    expect(VaultServerUrl.parse(' https://vault.example.com/ ')).toBe('https://vault.example.com')
    for (const url of [
      'http://127.0.0.1:8080/vw',
      'http://localhost',
      'http://[::1]:80/',
      'http://vaultwarden',
      'http://vaultwarden:8080/',
    ]) {
      expect(VaultServerUrl.safeParse(url).success, url).toBe(true)
    }
  })

  it('不收别的协议、账号、查询参数与 #', () => {
    for (const url of [
      'ftp://vault.example.com',
      'http://vault.example.com',
      'http://127.0.0.1.example.com',
      'http://localhost.example.com',
      'http://192.168.1.2',
      'https://user:pw@vault.example.com',
      'https://vault.example.com/?a=1',
      'https://vault.example.com/#x',
      'vault.example.com',
    ]) {
      expect(VaultServerUrl.safeParse(url).success, url).toBe(false)
    }
  })

  it('不带点的主机名全是数字或十六进制时不收 http：URL 会把它规范成 IPv4 地址', () => {
    for (const url of [
      'http://3232235777',
      'http://3232235777:8080/',
      'http://2130706433',
      'http://0300',
      'http://0xc0a80101',
      'http://0X7F000001/vw',
    ]) {
      expect(VaultServerUrl.safeParse(url).success, url).toBe(false)
    }
    // 只是带数字的服务名照收
    for (const url of [
      'http://vault2',
      'http://2fa-vault',
      'http://0xvault',
      'https://3232235777',
    ]) {
      expect(VaultServerUrl.safeParse(url).success, url).toBe(true)
    }
  })
})

describe('取用的用途', () => {
  it('限长、不收控制字符，只有空白的当作没给', () => {
    expect(CredentialIdentifierQuery.parse({ identifier: 'nas', purpose: '  ' }).purpose).toBe(
      undefined,
    )
    expect(CredentialIdentifierQuery.parse({ identifier: 'nas', purpose: ' 备份 ' }).purpose).toBe(
      '备份',
    )
    expect(
      CredentialIdentifierQuery.safeParse({ identifier: 'nas', purpose: 'x'.repeat(201) }).success,
    ).toBe(false)
    expect(
      CredentialIdentifierQuery.safeParse({ identifier: 'nas', purpose: 'a\nb' }).success,
    ).toBe(false)
  })
})

describe('访问密钥的凭据能力', () => {
  it('不给时是不可用', () => {
    expect(
      KeyScopes.parse({ readLayers: [], writeLayers: [], maxSensitivity: 'public', admin: false })
        .credentials,
    ).toBe('none')
  })
})
