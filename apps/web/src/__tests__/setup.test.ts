import type { DatabaseCheck } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import { checkRows, lockedHint, setupFailure, summaryFacts } from '../setup'

const ok: DatabaseCheck = {
  failure: null,
  role: { name: 'kioku', superuser: false, bypassRls: false },
  extensions: [
    { name: 'vector', state: 'installed' },
    { name: 'zhparser', state: 'installed' },
  ],
  existing: 'empty',
  accounts: null,
  unrelatedTables: 0,
  problems: [],
  ready: true,
}

describe('初始化的数据库检查', () => {
  it('连不上时只列连接一项，写类别与下一步', () => {
    expect(
      checkRows({
        ...ok,
        failure: 'auth_failed',
        role: null,
        extensions: [],
        problems: [{ code: 'connection' }],
        ready: false,
      }),
    ).toEqual([
      {
        key: 'connection',
        label: '连接',
        value: '认证失败',
        verdict: 'blocked',
        detail: '检查用户名与密码。',
      },
    ])
  })

  it('全部通过时逐项写「通过」', () => {
    const rows = checkRows(ok)
    expect(rows.map((r) => [r.label, r.value, r.verdict])).toEqual([
      ['连接', '成功', 'passed'],
      ['角色', 'kioku', 'passed'],
      ['扩展 vector', '已安装', 'passed'],
      ['扩展 zhparser', '已安装', 'passed'],
      ['已有数据', '空库', 'passed'],
    ])
  })

  it('超级用户、缺扩展、旧结构拦住；已有账号与其他表只提醒', () => {
    const rows = checkRows({
      ...ok,
      role: { name: 'postgres', superuser: true, bypassRls: true },
      extensions: [
        { name: 'vector', state: 'available' },
        { name: 'zhparser', state: 'missing' },
      ],
      existing: 'pre_baseline',
      unrelatedTables: 2,
      problems: [
        { code: 'superuser' },
        { code: 'extension_not_installed', extension: 'vector' },
        { code: 'extension_missing', extension: 'zhparser' },
        { code: 'pre_baseline' },
      ],
      ready: false,
    })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey.role).toMatchObject({
      value: 'postgres（角色是超级用户，会绕过行级安全）',
      verdict: 'blocked',
    })
    expect(byKey.role!.detail).toContain('行级安全')
    expect(byKey['extension-vector']!.detail).toContain('CREATE EXTENSION vector')
    expect(byKey['extension-zhparser']!.detail).toContain('pgvector 与 zhparser')
    expect(byKey.existing).toMatchObject({ verdict: 'blocked' })
    expect(byKey.unrelated).toMatchObject({ value: '2 张', verdict: 'notice' })

    const existing = checkRows({ ...ok, existing: 'kioku', accounts: 3 }).find(
      (r) => r.key === 'existing',
    )
    expect(existing).toMatchObject({ value: '已有 Kioku 的数据（3 个账号）', verdict: 'notice' })
    expect(existing!.detail).toContain('将接入已有实例')
  })

  it('连接信息只说密码填没填，来源写在最前', () => {
    const facts = summaryFacts(
      {
        host: 'db',
        port: 5432,
        database: 'kioku',
        username: 'kioku',
        passwordSet: true,
        ssl: 'disable',
      },
      'env',
    )[0]!
    expect(facts.map((f) => [f.label, f.value])).toEqual([
      ['来源', '环境变量 DATABASE_URL'],
      ['主机', 'db'],
      ['端口', 5432],
      ['库名', 'kioku'],
      ['用户名', 'kioku'],
      ['密码', '已填'],
      ['SSL', 'disable'],
    ])
    expect(lockedHint('env')).toContain('DATABASE_URL')
    expect(lockedHint('file')).toContain('kioku.json')
  })

  it('检查没过的报错带着检查结果', () => {
    const check = {
      ...ok,
      ready: false,
      failure: 'timeout' as const,
      problems: [{ code: 'connection' as const }],
    }
    expect(
      setupFailure(new ApiError(400, '无法连接数据库：连接超时', { error: 'x', check }), '失败'),
    ).toEqual({ message: '无法连接数据库：连接超时', check })
    expect(setupFailure(new Error('x'), '失败')).toEqual({ message: '失败', check: null })
  })
})

describe('哪一项拦住只看服务端给的问题', () => {
  it('同样的事实，没有对应的问题就写通过', () => {
    // 规则在服务端：这里不按扩展状态自己推断
    const rows = checkRows({
      ...ok,
      extensions: [{ name: 'vector', state: 'available' }],
      problems: [],
    })
    expect(rows.find((r) => r.key === 'extension-vector')).toMatchObject({ verdict: 'passed' })
  })
})
