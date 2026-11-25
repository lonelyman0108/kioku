import { describe, expect, it } from 'vitest'

import { pgBossSsl } from '../queue'

describe('pgBossSsl 映射规则', () => {
  it('把 sslmode=require 与 no-verify 映射为不校验证书，与 postgres.js 行为保持一致', () => {
    expect(pgBossSsl(false, true)).toBe(false)
    expect(pgBossSsl('disable', true)).toBe(false)
    expect(pgBossSsl('require', true)).toEqual({ rejectUnauthorized: false })
    expect(pgBossSsl('no-verify', false)).toEqual({ rejectUnauthorized: false })
    expect(pgBossSsl('prefer', true)).toEqual({ rejectUnauthorized: false })
    expect(pgBossSsl('prefer', false)).toBe(false)
    expect(pgBossSsl('verify-full', true)).toEqual({})
    expect(pgBossSsl(true, true)).toEqual({})
    const custom = { ca: 'cert' }
    expect(pgBossSsl(custom, true)).toBe(custom)
  })
})
