import { describe, expect, it } from 'vitest'

import {
  buildSearchTags,
  CreateEntryRequest,
  deriveEntryTitle,
  EntryListQuery,
  firstMarkdownHeading,
  normalizeProjectSlug,
  normalizeSlugList,
  UpdateEntryRequest,
} from '../entries'

describe('entries contracts', () => {
  it('extracts first markdown heading outside code fences and rejects credential placeholders', () => {
    const body = [
      '```markdown',
      '# 围栏里的标题应跳过',
      '```',
      '',
      '## 真正的标题 ##',
      '正文内容',
    ].join('\n')
    expect(firstMarkdownHeading(body)).toBe('真正的标题')
    expect(firstMarkdownHeading('# 包含 {{cred:secret}} 的标题')).toBeNull()
    expect(deriveEntryTitle(undefined, body, 'm-234abc')).toBe('真正的标题')
    expect(deriveEntryTitle('显式标题', body, 'm-234abc')).toBe('显式标题')
    expect(deriveEntryTitle(undefined, '纯正文无标题', 'm-234abc')).toBe('m-234abc')
  })

  it('normalizes scene slugs, projects and search tags', () => {
    expect(normalizeSlugList([' Mac ', 'linux', 'mac', ''])).toEqual(['linux', 'mac'])
    expect(normalizeProjectSlug({ repoName: 'org/Kioku_Repo' })).toBe('kioku_repo')
    expect(normalizeProjectSlug({ dirName: '/Users/dev/My App' })).toBe('my-app')
    expect(
      buildSearchTags({
        shortId: 'm-234abc'.toUpperCase(),
        topics: ['docker', 'deploy'],
        envs: ['mac'],
        realms: ['work'],
        projects: ['kioku'],
        runtimes: ['claudecode'],
      }),
    ).toBe('m-234abc docker deploy mac work kioku claudecode')
  })

  it('validates entry create, update and list query schemas', () => {
    const created = CreateEntryRequest.parse({
      content: '# 标题\n正文',
      envs: ['Mac', 'linux', 'mac'],
      realms: ['Work'],
      isPinned: true,
    })
    expect(created.envs).toEqual(['linux', 'mac'])
    expect(created.realms).toEqual(['work'])
    expect(created.isPinned).toBe(true)

    const updated = UpdateEntryRequest.parse({
      expectedVersion: 2,
      promoteToEntry: true,
      validTo: '2027-01-01T00:00:00Z',
    })
    expect(updated.promoteToEntry).toBe(true)

    const query = EntryListQuery.parse({ q: 'docker', mode: 'lookup', limit: '20' })
    expect(query).toEqual({
      tab: 'all',
      q: 'docker',
      mode: 'lookup',
      limit: 20,
    })
  })
})
