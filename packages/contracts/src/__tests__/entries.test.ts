import { describe, expect, it } from 'vitest'

import {
  CreateEntryRequest,
  deriveEntryTitle,
  ENTRY_TITLE_MAX,
  EntryTitle,
  firstMarkdownHeading,
  hasHomogeneousRealms,
  TopicTag,
  UpdateEntryRequest,
} from '../entries'

describe('标题与主题标签', () => {
  it('标题去掉首尾空白后为 1 到上限长度，不允许控制字符与凭据占位符', () => {
    expect(EntryTitle.parse('  部署步骤  ')).toBe('部署步骤')
    expect(EntryTitle.safeParse('   ').success).toBe(false)
    expect(EntryTitle.safeParse('').success).toBe(false)
    expect(EntryTitle.safeParse('标'.repeat(ENTRY_TITLE_MAX)).success).toBe(true)
    expect(EntryTitle.safeParse('标'.repeat(ENTRY_TITLE_MAX + 1)).success).toBe(false)
    expect(EntryTitle.safeParse('第一行\n第二行').success).toBe(false)
    expect(EntryTitle.safeParse('密码 {{cred:wifi}}').success).toBe(false)
  })

  it('主题标签规范化为小写并拒绝空白和占位符', () => {
    expect(TopicTag.parse('  Git-Workflow ')).toBe('git-workflow')
    expect(TopicTag.safeParse('git workflow').success).toBe(false)
    expect(TopicTag.safeParse('{{cred:nas}}').success).toBe(false)
  })
})

describe('多变体创建与更新校验', () => {
  it('单切片与显式 variants 数组二选一', () => {
    expect(CreateEntryRequest.safeParse({ content: '通用正文' }).success).toBe(true)
    expect(
      CreateEntryRequest.safeParse({
        variants: [{ when: { env: ['mac'] }, content: 'Mac 做法' }],
      }).success,
    ).toBe(true)
    expect(CreateEntryRequest.safeParse({}).success).toBe(false)
    expect(
      CreateEntryRequest.safeParse({
        content: '正文',
        variants: [{ when: {}, content: '切片' }],
      }).success,
    ).toBe(false)
    expect(
      CreateEntryRequest.safeParse({
        when: { env: ['mac'] },
        variants: [{ when: {}, content: '切片' }],
      }).success,
    ).toBe(false)
  })

  it('同一词条内禁止重复 when 切片条件', () => {
    expect(
      CreateEntryRequest.safeParse({
        variants: [
          { when: { env: ['win', 'mac'], realm: ['work'] }, content: '甲' },
          { when: { realm: ['work'], env: ['mac', 'win'] }, content: '乙' },
        ],
      }).success,
    ).toBe(false)
  })

  it('机密词条禁止挂载相异 realm 切片，防止跨场域解锁', () => {
    expect(
      hasHomogeneousRealms([
        { when: { realm: ['work'], env: ['win'] } },
        { when: { realm: ['work'], env: ['mac'] } },
      ]),
    ).toBe(true)
    expect(hasHomogeneousRealms([{ when: {} }, { when: { realm: ['home'] } }])).toBe(false)
    expect(
      CreateEntryRequest.safeParse({
        sensitivity: 'secret',
        variants: [
          { when: { realm: ['work'] }, content: '工作秘密' },
          { when: { realm: ['home'] }, content: '家里秘密' },
        ],
      }).success,
    ).toBe(false)
    expect(
      UpdateEntryRequest.safeParse({
        id: 'm-234567',
        sensitivity: 'secret',
        variants: [
          { when: { realm: ['work'] }, content: '工作' },
          { when: { env: ['mac'] }, content: '无场域' },
        ],
      }).success,
    ).toBe(false)
  })
})

describe('正文首行标题 提取与机密防泄漏', () => {
  it('忽略代码块内标题，跳过包含凭据占位符的标题行', () => {
    const md = '```\n# 注释\n```\n\n#   真正的标题  \n正文'
    expect(firstMarkdownHeading(md)).toBe('真正的标题')
    expect(firstMarkdownHeading('# 账号 {{cred:nas}}')).toBeNull()
  })

  it('机密词条若未给标题或标题与任意切片首行相同，则回退为短 ID', () => {
    const variants = [{ content: '# 公司 VPN' }, { content: '# 家里路由器' }]
    expect(deriveEntryTitle(undefined, variants, 'm-234567', 'private')).toBe('公司 VPN')
    expect(deriveEntryTitle(undefined, variants, 'm-234567', 'secret')).toBe('m-234567')
    expect(deriveEntryTitle('家里路由器', variants, 'm-234567', 'secret')).toBe('m-234567')
    expect(deriveEntryTitle('内部访问凭证', variants, 'm-234567', 'secret')).toBe('内部访问凭证')
  })
})
