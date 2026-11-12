import { describe, expect, it } from 'vitest'

import { resolveBuildInfo } from '../buildInfo'
import { BUILD, VERSION } from '../version'

const now = new Date('2026-11-12T08:00:00Z')
const sha = 'abc1234'.padEnd(40, '0')
const git = () => ({ describe: 'v0.1.0-3-gabc1234-dirty', sha: sha.toUpperCase() })

describe('构建信息', () => {
  it('没有构建参数时取 git：版本是 git describe 的结果，提交是完整的 sha，构建时间是现在', () => {
    expect(resolveBuildInfo({}, git, now)).toEqual({
      version: 'v0.1.0-3-gabc1234-dirty',
      commit: sha,
      builtAt: '2026-11-12T08:00:00.000Z',
    })
  })

  it('给了构建参数时以它们为准，不看 git', () => {
    const given = 'f'.repeat(40)
    expect(
      resolveBuildInfo(
        {
          KIOKU_VERSION: '0.2.0',
          KIOKU_COMMIT: given,
          KIOKU_BUILD_TIME: '2026-11-01T00:00:00+08:00',
        },
        git,
        now,
      ),
    ).toEqual({ version: '0.2.0', commit: given, builtAt: '2026-10-31T16:00:00.000Z' })
  })

  it('只给了一部分构建参数：没给的版本是 dev、提交为空，不混进 git 的', () => {
    expect(resolveBuildInfo({ KIOKU_COMMIT: 'abcdef0' }, git, now)).toEqual({
      version: 'dev',
      commit: 'abcdef0',
      builtAt: '2026-11-12T08:00:00.000Z',
    })
    expect(resolveBuildInfo({ KIOKU_VERSION: 'edge', KIOKU_COMMIT: '' }, git, now).commit).toBe(
      null,
    )
  })

  it('取不到 git、构建参数不合法时退回 dev', () => {
    expect(resolveBuildInfo({}, () => null, now)).toEqual({
      version: 'dev',
      commit: null,
      builtAt: '2026-11-12T08:00:00.000Z',
    })
    expect(
      resolveBuildInfo(
        { KIOKU_VERSION: 'a b\nc', KIOKU_COMMIT: 'not-a-sha', KIOKU_BUILD_TIME: 'yesterday' },
        git,
        now,
      ),
    ).toEqual({ version: 'dev', commit: null, builtAt: '2026-11-12T08:00:00.000Z' })
  })

  it('直接跑源码时版本来自 git 或 dev，不是空的', () => {
    expect(VERSION).toBe(BUILD.version)
    expect(VERSION.length).toBeGreaterThan(0)
  })
})
