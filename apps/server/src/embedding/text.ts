import { createHash } from 'node:crypto'

import { normalizeWhen, type WhenCondition } from '@kioku/contracts'

const MAX_CHARS = 6000

// 变体切片嵌入文本：标题、主题、切面条件、disclosure、glossary 与切片正文，过长时截掉正文尾部
export function embeddingText(input: {
  title: string
  topics?: readonly string[]
  when?: WhenCondition
  disclosure: string | null
  glossary: readonly string[]
  content: string
}): string {
  const parts = [input.title]
  const topics = input.topics?.filter(Boolean) ?? []
  if (topics.length) parts.push(`主题：${topics.join('、')}`)
  const when = normalizeWhen(input.when)
  const whenTags = Object.entries(when).map(([dim, slugs]) => `${dim}:${slugs.join(',')}`)
  if (whenTags.length) parts.push(`切面：${whenTags.join(' ')}`)
  if (input.disclosure) parts.push(`何时想起：${input.disclosure}`)
  if (input.glossary.length) parts.push(`关键词：${input.glossary.join('、')}`)
  parts.push(input.content)
  return parts.join('\n').slice(0, MAX_CHARS)
}

export function textHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex')
}
