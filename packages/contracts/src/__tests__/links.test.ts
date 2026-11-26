import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_SLUG_RE,
  extractCredentialPlaceholders,
  extractCredentialSlugs,
  extractEntryLinksWithContext,
  extractTargetShortIds,
  extractWikiLinks,
  isShortId,
  normalizeShortId,
  SHORT_ID_RE,
  ShortId,
} from '../links'

describe('links & placeholders', () => {
  it('validates and normalizes short IDs', () => {
    const upper = 'm-234abc'.toUpperCase()
    expect(SHORT_ID_RE.test('m-234567')).toBe(true)
    expect(SHORT_ID_RE.test('m-0oil1u')).toBe(false)
    expect(isShortId(`  ${'m-abcdef'.toUpperCase()}  `)).toBe(true)
    expect(normalizeShortId(` ${upper} `)).toBe('m-234abc')
    expect(ShortId.parse(` ${upper} `)).toBe('m-234abc')
    expect(ShortId.safeParse('m-123456').success).toBe(false)
  })

  it('extracts wiki links with optional aliases in order', () => {
    const upper = 'm-234abc'.toUpperCase()
    const content = `参考 [[${upper}]] 以及 [[m-999xyz|部署说明]]，重复 [[m-234abc]] 忽略 [[m-000000]]`
    const parsed = extractWikiLinks(content)
    expect(parsed.map((item) => ({ id: item.targetShortId, alias: item.alias }))).toEqual([
      { id: 'm-234abc', alias: null },
      { id: 'm-999xyz', alias: '部署说明' },
      { id: 'm-234abc', alias: null },
    ])
    expect(extractTargetShortIds(content)).toEqual(['m-234abc', 'm-999xyz'])

    const withContext = extractEntryLinksWithContext(
      [
        '- 数据库配置见 [[m-234abc|依赖：统一数据层]]，务必核对连接串',
        '[[m-999xyz]]',
        '- 再次提及 [[m-999xyz|排障教训]]，参见历史事故',
      ].join('\n'),
    )
    expect(withContext).toEqual([
      {
        targetShortId: 'm-234abc',
        relation: '依赖：统一数据层',
        contextSnippet: '数据库配置见 [[m-234abc|依赖：统一数据层]]，务必核对连接串',
      },
      {
        targetShortId: 'm-999xyz',
        relation: '排障教训',
        contextSnippet: '再次提及 [[m-999xyz|排障教训]]，参见历史事故',
      },
    ])
  })

  it('extracts both bare and field credential placeholders', () => {
    expect(CREDENTIAL_SLUG_RE.test('pg.main_1-prod')).toBe(true)
    expect(CREDENTIAL_SLUG_RE.test('-bad')).toBe(false)
    const content = '用 {{cred:pg-main}} 与 {{cred:github_pat#token}} 以及重复 {{cred:PG-MAIN}}'
    const refs = extractCredentialPlaceholders(content)
    expect(refs.map((r) => ({ slug: r.slug, field: r.field }))).toEqual([
      { slug: 'pg-main', field: null },
      { slug: 'github_pat', field: 'token' },
      { slug: 'pg-main', field: null },
    ])
    expect(extractCredentialSlugs(content)).toEqual(['pg-main', 'github_pat'])
  })
})
