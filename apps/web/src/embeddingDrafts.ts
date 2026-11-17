import type { EmbeddingSetupView, EmbeddingStatus } from '@kioku/contracts'

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

export function profileIdsChanged(draft: readonly string[], saved: readonly string[]): boolean {
  return draft.length !== saved.length || draft.some((id, i) => saved[i] !== id)
}
