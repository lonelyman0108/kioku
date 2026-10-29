import { describe, expect, it } from 'vitest'

import {
  draftOf,
  draftsChanged,
  followEmbedding,
  inputOf,
  switchEnded,
  switchTracker,
} from '../embeddingDrafts'

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

  it('页面开着时读到的变化才算：打开前缓存里的「正在换」不拿来比较', () => {
    // 回到页面：缓存里还在换，打开之后读到的已经切过去了，不提示
    const back = switchTracker()
    expect(back(false, fresh, old)).toBeNull()
    expect(back(true, null, fresh)).toBeNull()
    // 打开之后先读到还在换，再读到切过去或者被放弃
    const watching = switchTracker()
    expect(watching(false, fresh, old)).toBeNull()
    expect(watching(true, fresh, old)).toBeNull()
    expect(watching(true, fresh, old)).toBeNull()
    expect(watching(true, null, fresh)).toBe('switched')
    expect(watching(true, null, fresh)).toBeNull()
    const abandoned = switchTracker()
    expect(abandoned(true, fresh, old)).toBeNull()
    expect(abandoned(true, null, old)).toBe('abandoned')
  })
})

describe('向量进度要不要接着刷新', () => {
  const progress = (model: string, embedded: number) => ({ model, embedded })
  const status = (eligible: number, active: number | null, next: number | null = null) => ({
    eligible,
    active: active === null ? null : progress('old', active),
    next: next === null ? null : progress('new', next),
    lastError: null,
  })

  it('正在换模型时一直刷，补齐了也要等它切过去', () => {
    expect(followEmbedding(status(10, 10, 3))).toBe(true)
    expect(followEmbedding(status(10, 10, 10))).toBe(true)
  })

  it('正在用的模型还有记忆没有向量时接着刷（现在切换之后、刚配好、补不上的）', () => {
    expect(followEmbedding(status(10, 4))).toBe(true)
    expect(followEmbedding(status(10, 0))).toBe(true)
  })

  it('补齐了、没配模型、还没读到进度时不刷', () => {
    expect(followEmbedding(status(10, 10))).toBe(false)
    expect(followEmbedding(status(0, 0))).toBe(false)
    expect(followEmbedding(status(10, null))).toBe(false)
    expect(followEmbedding(undefined)).toBe(false)
  })
})
