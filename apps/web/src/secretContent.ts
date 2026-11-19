import { whenSignature, type ConsoleEntryView } from '@kioku/contracts'

// 显式查看拿到的机密正文。只放在编辑器组件里，不进 useQuery 的缓存：切到别的记忆、别的页面就丢，
// 回来要再查看一次（服务端记一次访问）。对应读到时的那一版：版本变了说明正文可能变了，不能接着显示
export interface RevealedContent {
  id: string
  version: number
  variantsBySig: Readonly<Record<string, string>>
}

// 从显式查看接口的响应提取明文切片内容
export function revealedFromEntry(view: ConsoleEntryView): RevealedContent {
  const entries: [string, string][] = []
  for (const variant of view.variants) {
    if (variant.content !== null) entries.push([variant.whenSignature, variant.content])
  }
  return {
    id: view.id,
    version: view.version,
    variantsBySig: Object.fromEntries(entries),
  }
}

// 服务器给的一版（机密的正文是 null）配上查看过的正文：同一条、同一版才配得上
export function withRevealed(
  view: ConsoleEntryView,
  revealed: RevealedContent | null,
): ConsoleEntryView {
  if (!view.contentHidden || !stillRevealed(view, revealed)) return view
  return {
    ...view,
    contentHidden: false,
    variants: view.variants.map((variant) => {
      const content = revealed.variantsBySig[variant.whenSignature] ?? variant.content
      return {
        ...variant,
        content,
        contentHidden: content === null,
      }
    }),
  }
}

export function stillRevealed(
  view: Pick<ConsoleEntryView, 'id' | 'version'>,
  revealed: RevealedContent | null,
): revealed is RevealedContent {
  return !!revealed && revealed.id === view.id && revealed.version === view.version
}

// 保存之后机密的正文还是不给（content 为 null），但刚写进去的就是表单里这一份：接着显示，不用再查看一次，也不多记一次访问
export function revealedAfterWrite(
  next: ConsoleEntryView,
  sentVariants: readonly { when?: Record<string, readonly string[]> | null; content: string }[],
  fallback?: RevealedContent | null,
): RevealedContent | null {
  if (!next.contentHidden) return null
  const map: Record<string, string> = {}
  for (const variant of sentVariants) {
    map[whenSignature(variant.when)] = variant.content
  }
  for (const variant of next.variants) {
    if (variant.whenSignature in map) continue
    const prev = fallback?.variantsBySig[variant.whenSignature]
    if (prev !== undefined) map[variant.whenSignature] = prev
  }
  return { id: next.id, version: next.version, variantsBySig: map }
}

// 查看过的正文收起来：这一版不变，只是正文又不在界面上了，再看要再查看一次（再记一次访问）
export function hiddenAgain(view: ConsoleEntryView): ConsoleEntryView {
  return {
    ...view,
    contentHidden: true,
    variants: view.variants.map((variant) => ({
      ...variant,
      content: null,
      contentHidden: true,
    })),
  }
}
