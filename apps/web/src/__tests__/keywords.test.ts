import { describe, expect, it } from 'vitest'

import { buildKeywordIndex, splitByKeywords } from '../keywords'

describe('正文里的关键词', () => {
  const index = buildKeywordIndex([
    { keyword: 'AI', shortIds: ['m-234567'] },
    { keyword: '阿尔法', shortIds: ['m-345678'] },
    { keyword: '阿尔法项目', shortIds: ['m-456789'] },
    { keyword: 'c++', shortIds: ['m-56789a'] },
    { keyword: '单', shortIds: ['m-6789ab'] },
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
      { keyword: 'Kioku', shortIds: ['m-234567'] },
      { keyword: 'kioku', shortIds: ['m-345678', 'm-234567'] },
    ])!
    expect(merged.targets.get('kioku')).toEqual(['m-234567', 'm-345678'])
    expect(buildKeywordIndex([{ keyword: '一', shortIds: ['m-234567'] }])).toBeNull()
  })
})
