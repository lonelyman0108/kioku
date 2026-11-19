import { describe, expect, it } from 'vitest'

import {
  BUILTIN_FACET_DIMENSIONS,
  BUILTIN_FACET_KEYS,
  CreateFacetDimensionRequest,
  FacetTermSlug,
  isBuiltinFacetKey,
  normalizeWhen,
  WhenCondition,
  whenSignature,
} from '../facets'

describe('内置维度与自定义维度校验', () => {
  it('内置四维固化 matchMode 与自动登记标志', () => {
    expect(BUILTIN_FACET_KEYS).toEqual(['realm', 'env', 'runtime', 'project'])
    expect(BUILTIN_FACET_DIMENSIONS.realm.matchMode).toBe('exclusive')
    expect(BUILTIN_FACET_DIMENSIONS.env.matchMode).toBe('exclusive')
    expect(BUILTIN_FACET_DIMENSIONS.runtime.matchMode).toBe('exclusive')
    expect(BUILTIN_FACET_DIMENSIONS.project.matchMode).toBe('additive')
    expect(BUILTIN_FACET_DIMENSIONS.project.autoRegister).toBe(true)
    expect(isBuiltinFacetKey('realm')).toBe(true)
    expect(isBuiltinFacetKey('role')).toBe(false)
  })

  it('自定义维度禁止占用内置维度键名', () => {
    for (const key of BUILTIN_FACET_KEYS) {
      expect(
        CreateFacetDimensionRequest.safeParse({ key, name: '重名', matchMode: 'exclusive' })
          .success,
      ).toBe(false)
    }
    expect(
      CreateFacetDimensionRequest.safeParse({ key: 'role', name: '角色', matchMode: 'additive' })
        .success,
    ).toBe(true)
  })
})

describe('切面词条规范化与签名', () => {
  it('词条标识支持小写、数字、中文与常见符号，拒绝空白与占位符', () => {
    expect(FacetTermSlug.parse(' 公司 ')).toBe('公司')
    expect(FacetTermSlug.parse('Office-PC')).toBe('office-pc')
    expect(FacetTermSlug.safeParse('two words').success).toBe(false)
    expect(FacetTermSlug.safeParse('{{cred:wifi}}').success).toBe(false)
  })

  it('normalizeWhen 与 whenSignature 对维度排序、空数组剔除与同维去重保序', () => {
    expect(normalizeWhen({ env: ['win', 'Win', 'mac'], empty: [], realm: ['Work'] })).toEqual({
      env: ['mac', 'win'],
      realm: ['work'],
    })
    const sigA = whenSignature({ realm: ['work'], env: ['win', 'mac'] })
    const sigB = whenSignature({ env: ['mac', 'win'], realm: ['WORK'] })
    expect(sigA).toBe(sigB)
    expect(whenSignature({ env: [] })).toBe('{}')
    expect(WhenCondition.parse({ Env: ['Mac'] })).toEqual({ env: ['mac'] })
  })
})
