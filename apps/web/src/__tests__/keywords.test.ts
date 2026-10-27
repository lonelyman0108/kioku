import { describe, expect, it } from 'vitest'

import { buildKeywordIndex, splitByKeywords } from '../keywords'

describe('正文里的关键词', () => {
  const index = buildKeywordIndex([
    { keyword: 'AI', uris: ['notes://ai'] },
    { keyword: '阿尔法', uris: ['projects://alpha'] },
    { keyword: '阿尔法项目', uris: ['projects://alpha-plan'] },
    { keyword: 'c++', uris: ['notes://cpp'] },
    { keyword: '单', uris: ['notes://single'] },
  ])!

  it('英文按单词边界、不区分大小写，中文按子串，长的优先', () => {
    expect(splitByKeywords('ai 说了 said，阿尔法项目开始了', index)).toEqual([
      { text: 'ai', keyword: 'ai' },
      { text: ' 说了 said，' },
      { text: '阿尔法项目', keyword: '阿尔法项目' },
      { text: '开始了' },
    ])
    expect(
      splitByKeywords('阿尔法和 AI', index)
        .filter((s) => s.keyword)
        .map((s) => s.text),
    ).toEqual(['阿尔法', 'AI'])
  })

  it('关键词里的正则符号按字面匹配；单字关键词不用', () => {
    expect(splitByKeywords('学 C++ 很难', index)).toEqual([
      { text: '学 ' },
      { text: 'C++', keyword: 'c++' },
      { text: ' 很难' },
    ])
    expect(splitByKeywords('单个', index)).toEqual([{ text: '单个' }])
  })

  it('同一个关键词合并多条记忆；没有可用的关键词时返回 null', () => {
    const merged = buildKeywordIndex([
      { keyword: 'Kioku', uris: ['a://1'] },
      { keyword: 'kioku', uris: ['a://2', 'a://1'] },
    ])!
    expect(merged.targets.get('kioku')).toEqual(['a://1', 'a://2'])
    expect(buildKeywordIndex([{ keyword: '一', uris: ['a://x'] }])).toBeNull()
  })
})
