import { describe, expect, it } from 'vitest'

import { draftOf, draftsChanged, inputOf } from '../embeddingDrafts'

const saved = { id: 'c1', baseUrl: 'https://e.example.com/v1', model: 'm', hasApiKey: true }

describe('嵌入渠道的草稿', () => {
  it('Key 留空时沿用已保存的，勾了清除时发 null，填了就发新的', () => {
    const draft = draftOf(saved)
    expect(inputOf(draft)).toEqual({ id: 'c1', baseUrl: saved.baseUrl, model: 'm' })
    expect(inputOf({ ...draft, clearKey: true })).toMatchObject({ apiKey: null })
    expect(inputOf({ ...draft, apiKey: 'sk-new' })).toMatchObject({ apiKey: 'sk-new' })
    expect(inputOf(draftOf())).not.toHaveProperty('id')
  })

  it('顺序、地址、模型名与 Key 的改动都算有改动', () => {
    const other = { ...saved, id: 'c2', baseUrl: 'https://f.example.com/v1' }
    const drafts = [draftOf(saved), draftOf(other)]
    expect(draftsChanged(drafts, [saved, other])).toBe(false)
    expect(draftsChanged([drafts[1]!, drafts[0]!], [saved, other])).toBe(true)
    expect(draftsChanged([{ ...drafts[0]!, model: 'm2' }, drafts[1]!], [saved, other])).toBe(true)
    expect(draftsChanged([{ ...drafts[0]!, apiKey: 'x' }, drafts[1]!], [saved, other])).toBe(true)
    expect(draftsChanged([drafts[0]!], [saved, other])).toBe(true)
  })
})
