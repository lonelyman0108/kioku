import { describe, expect, it } from 'vitest'

import { externalMethod, shellQuote } from '../methods'

describe('外部来源的取法', () => {
  it("单引号转义：内容里的单引号写成 '\\''", () => {
    expect(shellQuote('router admin')).toBe("'router admin'")
    expect(shellQuote("Bob's NAS")).toBe("'Bob'\\''s NAS'")
  })

  it('条目位置与来源字段代入命令时都在单引号里', () => {
    const fields = [
      { name: 'password', sourceField: 'password' },
      { name: 'token', sourceField: 'API token' },
    ]
    expect(externalMethod('bitwarden', 'router admin', fields)).toContain(
      "bw get item 'router admin'",
    )
    // 不用 --fields：它按逗号拆分来源字段
    const op = externalMethod('1password', 'Private/router', fields)
    expect(op).toContain("op item get 'Private/router' --reveal --format json")
    expect(op).not.toContain('--fields')
    expect(
      externalMethod('env', 'unused', [{ name: 'token', sourceField: 'API_TOKEN' }]),
    ).toContain("token 用 printenv 'API_TOKEN'")
    const other = externalMethod('other', 'router admin', fields)
    expect(other).toContain("条目 'router admin'")
    // 字段对应只写一遍，来源字段放在单引号里
    expect(other).toContain(
      "字段对应（占位符字段 → 条目里的字段）：password → 'password'，token → 'API token'",
    )
    expect(other.match(/API token/g)).toHaveLength(1)
  })
})
