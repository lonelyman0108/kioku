import type { ConsoleMemoryView } from '@kioku/contracts'

// 显式查看拿到的机密正文。只放在编辑器组件里，不进 useQuery 的缓存：切到别的记忆、别的页面就丢，
// 回来要再查看一次（服务端记一次访问）。对应读到时的那一版：版本变了说明正文可能变了，不能接着显示
export interface RevealedContent {
  id: string
  version: number
  content: string
}

// 服务器给的一版（机密的正文是 null）配上查看过的正文：同一条、同一版才配得上
export function withRevealed(
  view: ConsoleMemoryView,
  revealed: RevealedContent | null,
): ConsoleMemoryView {
  if (!view.contentHidden || !stillRevealed(view, revealed)) return view
  return { ...view, content: revealed.content, contentHidden: false }
}

export function stillRevealed(
  view: Pick<ConsoleMemoryView, 'id' | 'version'>,
  revealed: RevealedContent | null,
): revealed is RevealedContent {
  return !!revealed && revealed.id === view.id && revealed.version === view.version
}

// 保存之后机密的正文还是不给（content 为 null），但刚写进去的就是表单里这一份：接着显示，不用再查看一次，也不多记一次访问
export function revealedAfterWrite(
  next: ConsoleMemoryView,
  content: string,
): RevealedContent | null {
  return next.contentHidden ? { id: next.id, version: next.version, content } : null
}

// 查看过的正文收起来：这一版不变，只是正文又不在界面上了，再看要再查看一次（再记一次访问）
export function hiddenAgain(view: ConsoleMemoryView): ConsoleMemoryView {
  return { ...view, content: null, contentHidden: true }
}
