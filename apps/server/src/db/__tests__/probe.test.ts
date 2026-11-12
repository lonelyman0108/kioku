import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  assess,
  connectionUrl,
  failureOf,
  scramVerifier,
  summarize,
  type DatabaseFacts,
} from '../probe'

const facts: DatabaseFacts = {
  role: { name: 'kioku', superuser: false, bypassRls: false },
  extensions: [
    { name: 'vector', state: 'installed' },
    { name: 'zhparser', state: 'installed' },
  ],
  existing: 'empty',
  accounts: null,
  unrelatedTables: 0,
}

describe('数据库检查', () => {
  it('连不上的原因只按 code 分类', () => {
    const cases: [unknown, string][] = [
      [{ code: 'ECONNREFUSED' }, 'unreachable'],
      [{ code: 'ENOTFOUND' }, 'host_not_found'],
      [{ code: 'CONNECT_TIMEOUT' }, 'timeout'],
      [{ code: '28P01' }, 'auth_failed'],
      [{ code: 'SASL_SIGNATURE_MISMATCH' }, 'auth_failed'],
      [{ code: '28000' }, 'not_allowed'],
      [{ code: '3D000' }, 'database_missing'],
      [{ code: '42501' }, 'permission_denied'],
      [{ code: 'SSL_NOT_SUPPORTED' }, 'ssl_unsupported'],
      [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'ssl_failed'],
      [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'ssl_failed'],
      [{ code: '57P03' }, 'busy'],
      [{ code: 'XX000' }, 'unknown'],
      [new Error('x'), 'unknown'],
      [null, 'unknown'],
    ]
    for (const [err, kind] of cases) expect(failureOf(err)).toBe(kind)
  })

  it('超级用户、BYPASSRLS、缺扩展、库的结构用不了时拦住；无关的表与已有账号只提醒', () => {
    expect(assess(facts).ready).toBe(true)
    expect(assess({ ...facts, unrelatedTables: 3 }).ready).toBe(true)
    expect(assess({ ...facts, existing: 'kioku', accounts: 2 }).ready).toBe(true)
    expect(assess({ ...facts, role: { ...facts.role, superuser: true } }).ready).toBe(false)
    expect(assess({ ...facts, role: { ...facts.role, bypassRls: true } }).ready).toBe(false)
    expect(
      assess({
        ...facts,
        extensions: [facts.extensions[0]!, { name: 'zhparser', state: 'available' }],
      }).ready,
    ).toBe(false)
    expect(assess({ ...facts, existing: 'pre_baseline' }).ready).toBe(false)
    expect(assess({ ...facts, existing: 'newer' }).ready).toBe(false)
  })

  it('表单拼出的连接串由 postgres.js 解析回同样的字段', () => {
    const connection = {
      host: '::1',
      port: 5433,
      database: 'kioku db',
      username: 'app@x',
      password: 'p@ss:/?#word',
      ssl: 'require' as const,
    }
    const url = connectionUrl(connection)
    expect(url).not.toContain('p@ss')
    expect(summarize(url)).toEqual({
      host: '::1',
      port: 5433,
      database: 'kioku db',
      username: 'app@x',
      passwordSet: true,
      ssl: 'require',
    })
    expect(
      summarize(connectionUrl({ ...connection, host: 'db', password: '', ssl: 'disable' })),
    ).toMatchObject({ host: 'db', passwordSet: false, ssl: 'disable' })
  })

  it('SCRAM 口令按 RFC 5802 的算法算出，和明文对得上', () => {
    const verifier = scramVerifier('secret-password')
    const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier)
    expect(m).not.toBeNull()
    const salted = pbkdf2Sync('secret-password', Buffer.from(m![1]!, 'base64'), 4096, 32, 'sha256')
    const clientKey = createHmac('sha256', salted).update('Client Key').digest()
    expect(createHash('sha256').update(clientKey).digest('base64')).toBe(m![2])
    expect(createHmac('sha256', salted).update('Server Key').digest('base64')).toBe(m![3])
    expect(verifier).not.toContain('secret-password')
  })
})
