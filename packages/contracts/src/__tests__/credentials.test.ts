import { describe, expect, it } from 'vitest'

import {
  ConvertTarget,
  CreateCredentialRequest,
  CredentialEventQuery,
  CredentialExpiresAt,
  CredentialIdentifierQuery,
  CredentialListQuery,
  CredentialStoredIn,
  CredentialUrl,
  CredentialWriteError,
  defaultCredentialFields,
  isVaultFieldRef,
  KeyCreateCredentialRequest,
  KeyScopes,
  KeyUpdateCredentialRequest,
  SetVaultDestinationRequest,
  UpdateCredentialRequest,
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

describe('到期时间', () => {
  it('收带时区的时间与 null，过去的时间也收', () => {
    for (const v of ['2027-01-01T00:00:00Z', '2027-01-01T08:00:00+08:00', '2020-01-01T00:00:00Z']) {
      expect(CredentialExpiresAt.safeParse(v).success, v).toBe(true)
    }
    expect(CredentialExpiresAt.safeParse(null).success).toBe(true)
  })

  it('不收不带时区的、不是时间的与超出范围的', () => {
    for (const v of ['2027-01-01', '2027-01-01T00:00:00', 'tomorrow', '1999-12-31T00:00:00Z']) {
      expect(CredentialExpiresAt.safeParse(v).success, v).toBe(false)
    }
  })
})

describe('写进密码库的网址', () => {
  it('只收 http 与 https，前后的空白去掉', () => {
    expect(CredentialUrl.parse(' https://files.example.com:8443/login ')).toBe(
      'https://files.example.com:8443/login',
    )
    expect(CredentialUrl.safeParse('http://127.0.0.1:8080').success).toBe(true)
    for (const v of [
      'ftp://example.com',
      'example.com',
      'https://',
      'https://a b',
      'https://a\u0000',
    ]) {
      expect(CredentialUrl.safeParse(v).success, v).toBe(false)
    }
    expect(CredentialUrl.safeParse(`https://example.com/${'x'.repeat(2000)}`).success).toBe(false)
  })
})

describe('新建凭据', () => {
  const values = { password: 'hunter2' }

  it('管理界面新建带值的写 new，不再有 hosted', () => {
    const base = { identifier: 'nas', name: 'NAS' }
    expect(
      CreateCredentialRequest.safeParse({
        ...base,
        source: { kind: 'new', values, url: 'https://nas.example.com' },
        expiresAt: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(true)
    expect(
      CreateCredentialRequest.safeParse({ ...base, source: { kind: 'hosted', values } }).success,
    ).toBe(false)
  })

  it('通过 Key 新建可以带网址与到期时间，不选去处', () => {
    const parsed = KeyCreateCredentialRequest.parse({
      identifier: 'nas',
      name: 'NAS',
      values,
      url: 'https://nas.example.com',
      expiresAt: null,
      destination: 'hosted',
    })
    expect(parsed).not.toHaveProperty('destination')
    expect(parsed.url).toBe('https://nas.example.com')
  })

  it('响应说明写到了哪里', () => {
    expect(CredentialStoredIn.safeParse({ kind: 'hosted', bench: false }).success).toBe(true)
    expect(CredentialStoredIn.safeParse({ kind: 'vault', collectionName: 'Agent' }).success).toBe(
      true,
    )
    expect(CredentialStoredIn.safeParse({ kind: 'vault' }).success).toBe(false)
  })

  it('转存的新建写 new，可以带网址与到期时间', () => {
    const target = { kind: 'new', identifier: 'wifi', name: '无线网络', field: 'password' }
    expect(ConvertTarget.safeParse({ ...target, url: 'https://wifi.example.com' }).success).toBe(
      true,
    )
    expect(ConvertTarget.safeParse({ ...target, kind: 'hosted' }).success).toBe(false)
  })
})

describe('修改凭据', () => {
  it('需要轮换只在管理界面改，访问密钥的请求里没有它', () => {
    expect(
      UpdateCredentialRequest.parse({ expectedVersion: 1, needsRotation: true }).needsRotation,
    ).toBe(true)
    expect(
      KeyUpdateCredentialRequest.parse({
        identifier: 'nas',
        expectedVersion: 1,
        needsRotation: true,
      }),
    ).not.toHaveProperty('needsRotation')
  })

  it('到期时间两边都能设，null 清掉', () => {
    expect(UpdateCredentialRequest.parse({ expectedVersion: 1, expiresAt: null }).expiresAt).toBe(
      null,
    )
    expect(
      KeyUpdateCredentialRequest.parse({
        identifier: 'nas',
        expectedVersion: 1,
        expiresAt: '2027-01-01T00:00:00Z',
      }).expiresAt,
    ).toBe('2027-01-01T00:00:00Z')
  })
})

describe('筛选与去处', () => {
  it('待处理的凭据与上次改值以来的取用只收 true', () => {
    expect(CredentialListQuery.parse({ attention: 'true' }).attention).toBe('true')
    expect(CredentialListQuery.safeParse({ attention: 'false' }).success).toBe(false)
    expect(CredentialEventQuery.parse({ sinceValueChange: 'true' })).toMatchObject({
      sinceValueChange: 'true',
      limit: 50,
    })
    expect(CredentialEventQuery.safeParse({ sinceValueChange: '1' }).success).toBe(false)
  })

  it('去处只给集合 id', () => {
    expect(
      SetVaultDestinationRequest.safeParse({ collectionId: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
        .success,
    ).toBe(true)
    expect(SetVaultDestinationRequest.safeParse({ collectionId: '../x' }).success).toBe(false)
  })
})

describe('写入的错误体', () => {
  it('原因只收几种，留在密码库里的条目可选', () => {
    for (const reason of ['version', 'item_conflict', 'read_only', 'value_too_long']) {
      expect(CredentialWriteError.safeParse({ error: 'x', reason }).success, reason).toBe(true)
    }
    expect(CredentialWriteError.safeParse({ error: 'x', reason: 'other' }).success).toBe(false)
    expect(
      CredentialWriteError.safeParse({
        error: 'x',
        vaultItem: {
          connectionId: '00000000-0000-4000-8000-000000000000',
          itemId: 'item-1',
          itemName: '邮箱',
          collectionName: 'Agent',
        },
      }).success,
    ).toBe(true)
  })
})
