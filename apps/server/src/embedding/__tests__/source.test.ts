import { describe, expect, it, vi } from 'vitest'

import type { Db } from '../../db/client'

vi.mock('../settings', () => ({ loadEmbeddingSetups: vi.fn() }))
const { loadEmbeddingSetups } = await import('../settings')
const { settingsEmbedderSource } = await import('../source')

const channel = { baseUrl: 'https://e.example.com/v1', model: 'remote-name', apiKey: null }

describe('嵌入设置缓存', () => {
  it('读取失败不缓存，下次重试', async () => {
    const load = vi.mocked(loadEmbeddingSetups)
    load.mockRejectedValueOnce(new Error('连接中断'))
    load.mockResolvedValueOnce({ active: { model: 'm', channels: [channel] }, next: null })
    const source = settingsEmbedderSource({} as Db, null)
    await expect(source.get()).rejects.toThrow('连接中断')
    expect((await source.get())?.model).toBe('m')
    expect(await source.next()).toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('向量按模型标识存，不按渠道请求时用的模型名；换模型时两个都给', async () => {
    vi.mocked(loadEmbeddingSetups).mockResolvedValueOnce({
      active: { model: 'old', channels: [channel] },
      next: { model: 'new', channels: [channel] },
    })
    const source = settingsEmbedderSource({} as Db, null)
    expect((await source.get())?.model).toBe('old')
    expect((await source.next())?.model).toBe('new')
  })
})
