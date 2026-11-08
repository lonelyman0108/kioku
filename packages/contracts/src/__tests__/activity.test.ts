import { describe, expect, it } from 'vitest'

import {
  ActivityActorKey,
  ActivityDaysQuery,
  ActivityFieldChange,
  ActivityFilter,
  ActivityQuery,
} from '../console'

const uuid = '0f9c2d6e-1b2a-4c3d-8e4f-5a6b7c8d9e0f'

describe('变更记录的筛选', () => {
  it('多个值用逗号连在一个参数里，空段忽略', () => {
    const parsed = ActivityFilter.parse({
      type: 'create,update,',
      layer: 'core,user',
      field: 'content,none',
      actor: `account:${uuid},bench`,
      exceptActor: `app:${uuid}`,
    })
    expect(parsed).toEqual({
      type: ['create', 'update'],
      layer: ['core', 'user'],
      field: ['content', 'none'],
      actor: [`account:${uuid}`, 'bench'],
      exceptActor: [`app:${uuid}`],
    })
  })

  it('不认识的值、访问事件、空的列表都不收', () => {
    for (const bad of [
      { type: 'access' },
      { type: ',' },
      { layer: 'nope' },
      { field: 'version' },
      { actor: 'key:1' },
      { actor: `account:${uuid.toUpperCase()}` },
    ]) {
      expect(ActivityFilter.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('操作者四种写法', () => {
    for (const key of [`account:${uuid}`, `app:${uuid}`, 'bench', 'unknown']) {
      expect(ActivityActorKey.safeParse(key).success).toBe(true)
    }
    expect(ActivityActorKey.safeParse('benchmark').success).toBe(false)
  })

  it('时间范围：不早于 from、早于 to，结束不能早于开始，跨度最多 400 天', () => {
    const ok = (from: string, to: string) => ActivityFilter.safeParse({ from, to }).success
    expect(ok('2026-11-01T00:00:00+08:00', '2026-11-01T00:00:00+08:00')).toBe(true)
    expect(ok('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z')).toBe(false)
    expect(ok('2025-10-04T00:00:00Z', '2026-11-08T00:00:00Z')).toBe(true)
    expect(ok('2025-10-03T00:00:00Z', '2026-11-08T00:00:00Z')).toBe(false)
    expect(ActivityFilter.safeParse({ from: '2026-11-01' }).success).toBe(false)
  })

  it('关键字最多 100 字，去掉首尾空白', () => {
    expect(ActivityFilter.parse({ q: '  会话 ' }).q).toBe('会话')
    expect(ActivityFilter.safeParse({ q: 'x'.repeat(101) }).success).toBe(false)
    expect(ActivityFilter.safeParse({ q: '   ' }).success).toBe(false)
  })

  it('列表带翻页参数，按天计数要时区', () => {
    expect(ActivityQuery.parse({ limit: '20' }).limit).toBe(20)
    expect(ActivityQuery.safeParse({ from: 'x' }).success).toBe(false)
    expect(ActivityDaysQuery.safeParse({}).success).toBe(false)
    expect(ActivityDaysQuery.parse({ tz: 'Asia/Shanghai' }).tz).toBe('Asia/Shanghai')
    expect(ActivityDaysQuery.parse({ tz: 'UTC' }).tz).toBe('UTC')
    for (const tz of ['Mars/Base', "UTC'; --", 'Asia/Shanghai '.repeat(10)]) {
      expect(ActivityDaysQuery.safeParse({ tz }).success, tz).toBe(false)
    }
  })
})

describe('字段的前后值', () => {
  it('正文给行数或两个都是 null，关键词给词，标量给前后', () => {
    expect(ActivityFieldChange.safeParse({ field: 'content', added: 1, removed: 0 }).success).toBe(
      true,
    )
    expect(
      ActivityFieldChange.safeParse({ field: 'content', added: null, removed: null }).success,
    ).toBe(true)
    expect(
      ActivityFieldChange.safeParse({ field: 'glossary', added: ['甲方'], removed: [] }).success,
    ).toBe(true)
    expect(
      ActivityFieldChange.safeParse({ field: 'title', before: null, after: '标题' }).success,
    ).toBe(true)
    expect(
      ActivityFieldChange.safeParse({ field: 'priority', before: '1', after: 2 }).success,
    ).toBe(false)
    expect(
      ActivityFieldChange.safeParse({ field: 'layer', before: 'core', after: 'nope' }).success,
    ).toBe(false)
  })
})
