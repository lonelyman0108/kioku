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
  redirectWikiLinksInContent,
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

  it('redirects wiki links while preserving aliases and skipping code blocks and inline code', () => {
    const upperOld = 'm-234abc'.toUpperCase()
    const input = [
      `正文引用 [[${upperOld}]] 与 [[m-234abc|部署说明]]，保留 [[m-777def]]。`,
      '行内代码 `[[m-234abc]]` 和 `[[m-234abc|别名]]` 不得替换。',
      '```markdown',
      '代码块中的 [[m-234abc]] 与 [[m-234abc|示例]] 不得替换。',
      '```',
      '块后再次引用 [[m-234abc|收尾说明]]。',
    ].join('\n')

    const map = new Map([['m-234abc', 'm-999xyz']])
    const out = redirectWikiLinksInContent(input, map)
    expect(out.replacedCount).toBe(3)
    expect(out.redirectedTargets).toEqual(['m-234abc'])
    expect(out.content).toBe(
      [
        '正文引用 [[m-999xyz]] 与 [[m-999xyz|部署说明]]，保留 [[m-777def]]。',
        '行内代码 `[[m-234abc]]` 和 `[[m-234abc|别名]]` 不得替换。',
        '```markdown',
        '代码块中的 [[m-234abc]] 与 [[m-234abc|示例]] 不得替换。',
        '```',
        '块后再次引用 [[m-999xyz|收尾说明]]。',
      ].join('\n'),
    )

    // 无命中映射时原样返回
    const noop = redirectWikiLinksInContent('普通文本 [[m-777def]]', map)
    expect(noop).toEqual({
      content: '普通文本 [[m-777def]]',
      replacedCount: 0,
      redirectedTargets: [],
    })

    // CommonMark 多反引号行内代码、未闭合反引号与 CRLF 边界
    const complex =
      '双反引号 ``use `[[m-234abc]]` here`` 后接正文 [[m-234abc|外链]]\r\n空双反引号 `` 后接 [[m-234abc]] 与 `code`\r\n孤立反引号 ` [[m-234abc]]'
    const complexOut = redirectWikiLinksInContent(complex, map)
    expect(complexOut.replacedCount).toBe(3)
    expect(complexOut.content).toBe(
      '双反引号 ``use `[[m-234abc]]` here`` 后接正文 [[m-999xyz|外链]]\r\n空双反引号 `` 后接 [[m-999xyz]] 与 `code`\r\n孤立反引号 ` [[m-999xyz]]',
    )
  })
})
