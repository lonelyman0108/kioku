import { describe, expect, it } from 'vitest'

import { draftOf, draftsChanged, inputOf, switchEnded } from '../embeddingDrafts'

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

describe('换模型结束', () => {
  const old = { model: 'old', channels: [saved] }
  const fresh = { model: 'new', channels: [{ ...saved, id: 'c2', model: 'new' }] }
  const other = { model: 'other', channels: [] }

  it('正在换的模型没了：成了正在用的是切过去了，否则是放弃了', () => {
    expect(switchEnded(fresh, null, fresh)).toBe('switched')
    expect(switchEnded(fresh, null, old)).toBe('abandoned')
  })

  it('还在换、刚开始换、换成另一个新模型、本来就没在换都不算结束', () => {
    expect(switchEnded(fresh, fresh, old)).toBeNull()
    expect(switchEnded(null, fresh, old)).toBeNull()
    expect(switchEnded(fresh, other, old)).toBeNull()
    expect(switchEnded(undefined, null, old)).toBeNull()
    expect(switchEnded(null, null, old)).toBeNull()
  })
})
