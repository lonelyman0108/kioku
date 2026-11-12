import postgres from 'postgres'
import { describe, expect, it } from 'vitest'

import { postgresOptions } from '../../db/client'
import { connectionUrl } from '../../db/probe'
import { pgBossConnection, pgBossSsl } from '../queue'

describe('pg-boss 的连接选项按 postgres.js 的解析给', () => {
  it('各个 SSL 模式在两个驱动下一致', () => {
    expect(pgBossSsl(false, true)).toBe(false)
    expect(pgBossSsl('disable', true)).toBe(false)
    // require：加密但不校验证书（node-postgres 自己会把它当 verify-full）
    expect(pgBossSsl('require', false)).toEqual({ rejectUnauthorized: false })
    // prefer、allow：服务这条连接用上了 SSL 才加密，否则明文
    expect(pgBossSsl('prefer', true)).toEqual({ rejectUnauthorized: false })
    expect(pgBossSsl('prefer', false)).toBe(false)
    expect(pgBossSsl('allow', true)).toEqual({ rejectUnauthorized: false })
    expect(pgBossSsl('allow', false)).toBe(false)
    // verify-ca、verify-full：默认的证书与主机名校验
    expect(pgBossSsl('verify-ca', false)).toEqual({})
    expect(pgBossSsl('verify-full', false)).toEqual({})
    const custom = { ca: 'x' }
    expect(pgBossSsl(custom, false)).toBe(custom)
    expect(pgBossSsl('something-else', false)).toEqual({})
  })

  it('主机、端口、库名、用户与密码逐项传，不交给 node-postgres 去解析连接串', async () => {
    expect(
      await pgBossConnection(
        'postgres://app_user:p%40ss%2Fw@db.example.com:5433/kioku_db?sslmode=require',
      ),
    ).toEqual({
      host: 'db.example.com',
      port: 5433,
      database: 'kioku_db',
      user: 'app_user',
      password: 'p@ss/w',
      ssl: { rejectUnauthorized: false },
    })
    expect(await pgBossConnection('postgres://u@127.0.0.1/k?sslmode=disable')).toMatchObject({
      ssl: false,
      password: '',
    })
    expect(await pgBossConnection('postgres://u@[::1]:5432/k?sslmode=verify-full')).toMatchObject({
      host: '::1',
      ssl: {},
    })
  })

  it('初始化页填的特殊字符经 kioku.json 的连接串后，两个驱动拿到的库名、用户与密码完全一样', async () => {
    const form = {
      host: 'db.example.com',
      port: 5432,
      database: 'my-db',
      username: 'app@server',
      password: 'p@ss:w/o#r%d',
      ssl: 'disable' as const,
    }
    // 保存进 kioku.json 的就是这个连接串
    const url = connectionUrl(form)
    const { options } = postgres(url, postgresOptions({ max: 1 }))
    const boss = await pgBossConnection(url)
    expect({ database: options.database, user: options.user, password: options.pass }).toEqual({
      database: 'my-db',
      user: 'app@server',
      password: 'p@ss:w/o#r%d',
    })
    expect({ database: boss.database, user: boss.user, password: boss.password }).toEqual({
      database: 'my-db',
      user: 'app@server',
      password: 'p@ss:w/o#r%d',
    })
  })
})
