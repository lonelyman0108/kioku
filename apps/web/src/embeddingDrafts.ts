import type {
  EmbeddingChannelInput,
  EmbeddingChannelView,
  EmbeddingSetupView,
  EmbeddingStatus,
} from '@kioku/contracts'

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

// 设置里正在换过去的模型没了：切过去了（它成了正在用的模型），还是放弃了。还在换、本来就没在换时为 null
export function switchEnded(
  previous: EmbeddingSetupView | null | undefined,
  next: EmbeddingSetupView | null,
  active: EmbeddingSetupView | null,
): 'switched' | 'abandoned' | null {
  if (!previous || next) return null
  return active?.model === previous.model ? 'switched' : 'abandoned'
}

// 跟着设置每读一次看一眼换模型有没有结束。只比较页面打开之后读到的（fresh），打开前缓存里的旧设置不算：
// 回到页面时缓存里还是离开前的「正在换」，离开期间早就结束了的不能当成刚结束
export function switchTracker() {
  let last: EmbeddingSetupView | null | undefined
  return (
    fresh: boolean,
    next: EmbeddingSetupView | null,
    active: EmbeddingSetupView | null,
  ): ReturnType<typeof switchEnded> => {
    if (!fresh) return null
    const ended = last === undefined ? null : switchEnded(last, next, active)
    last = next
    return ended
  }
}

// 向量进度要不要接着刷新，只看进度本身：正在换模型，或者正在用的模型还有记忆没有向量（刚配好、现在切换之后、
// 刚写入一批，以及一直补不上的），就接着刷；补齐了就停
export function followEmbedding(status: EmbeddingStatus | undefined): boolean {
  if (!status) return false
  if (status.next) return true
  return status.active !== null && status.active.embedded < status.eligible
}
