import { describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'

vi.mock('../settings', () => ({ loadEmbeddingConfig: vi.fn() }))
const { loadEmbeddingConfig } = await import('../settings')
const { settingsEmbedderSource } = await import('../source')

describe('嵌入设置缓存', () => {
  it('读取失败不缓存，下次重试', async () => {
    const load = vi.mocked(loadEmbeddingConfig)
    load.mockRejectedValueOnce(new Error('连接中断'))
    load.mockResolvedValueOnce({ baseUrl: 'https://e.example.com/v1', model: 'm', apiKey: null })
    const source = settingsEmbedderSource({} as Db, null)
    await expect(source.get()).rejects.toThrow('连接中断')
    expect((await source.get())?.model).toBe('m')
    expect((await source.get())?.model).toBe('m')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
