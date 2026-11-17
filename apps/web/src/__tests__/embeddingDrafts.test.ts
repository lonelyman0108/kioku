import { describe, expect, it } from 'vitest'

import { followEmbedding, profileIdsChanged, switchEnded, switchTracker } from '../embeddingDrafts'

const savedChannel = {
  id: 'p1',
  profileId: 'p1',
  providerId: 'prov1',
  providerName: 'Provider',
  format: 'openai-chat' as const,
  baseUrl: 'https://e.example.com/v1',
  model: 'm',
  label: null,
  hasApiKey: true,
}

describe('嵌入模型顺位草稿', () => {
  it('顺序与增删改都算有改动', () => {
    expect(profileIdsChanged(['p1', 'p2'], ['p1', 'p2'])).toBe(false)
    expect(profileIdsChanged(['p2', 'p1'], ['p1', 'p2'])).toBe(true)
    expect(profileIdsChanged(['p1'], ['p1', 'p2'])).toBe(true)
    expect(profileIdsChanged(['p1', 'p3'], ['p1', 'p2'])).toBe(true)
  })
})

describe('换模型结束', () => {
  const old = { model: 'old', profileIds: ['p1'], channels: [savedChannel] }
  const fresh = {
    model: 'new',
    profileIds: ['p2'],
    channels: [{ ...savedChannel, id: 'p2', profileId: 'p2', model: 'new' }],
  }
  const other = { model: 'other', profileIds: [], channels: [] }

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
    const back = switchTracker()
    expect(back(false, fresh, old)).toBeNull()
    expect(back(true, null, fresh)).toBeNull()
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
