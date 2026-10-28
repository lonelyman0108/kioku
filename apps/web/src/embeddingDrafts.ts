import type { EmbeddingChannelInput, EmbeddingChannelView } from '@kioku/contracts'

// 一个嵌入渠道的编辑草稿：同一个模型的几个接口，按顺序请求，前一个出错时换下一个
export interface ChannelDraft {
  // 只用于列表渲染
  key: number
  id?: string
  baseUrl: string
  model: string
  // 留空表示沿用已保存的 Key
  apiKey: string
  clearKey: boolean
  hasApiKey: boolean
}

let nextKey = 0

export function draftOf(channel?: EmbeddingChannelView): ChannelDraft {
  return {
    key: nextKey++,
    id: channel?.id,
    baseUrl: channel?.baseUrl ?? '',
    model: channel?.model ?? '',
    apiKey: '',
    clearKey: false,
    hasApiKey: channel?.hasApiKey ?? false,
  }
}

export function inputOf(draft: ChannelDraft): EmbeddingChannelInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    baseUrl: draft.baseUrl,
    model: draft.model,
    ...(draft.clearKey ? { apiKey: null } : draft.apiKey ? { apiKey: draft.apiKey } : {}),
  }
}

// 草稿和保存下来的渠道比有没有改动：顺序、地址、模型名、Key 都算
export function draftsChanged(drafts: ChannelDraft[], saved: EmbeddingChannelView[]): boolean {
  return (
    drafts.length !== saved.length ||
    drafts.some((d, i) => {
      const s = saved[i]!
      return (
        d.id !== s.id ||
        d.baseUrl !== s.baseUrl ||
        d.model !== s.model ||
        d.apiKey !== '' ||
        d.clearKey
      )
    })
  )
}
