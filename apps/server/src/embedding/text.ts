import { createHash } from 'node:crypto'

const MAX_CHARS = 6000

// 嵌入文本：URI、disclosure、glossary 与正文。URI 和 disclosure 放前面，过长时截掉的是正文尾部
export function embeddingText(input: {
  uri: string
  disclosure: string | null
  glossary: string[]
  content: string
}): string {
  const parts = [input.uri]
  if (input.disclosure) parts.push(`何时想起：${input.disclosure}`)
  if (input.glossary.length) parts.push(`关键词：${input.glossary.join('、')}`)
  parts.push(input.content)
  return parts.join('\n').slice(0, MAX_CHARS)
}

export function textHash(model: string, text: string): string {
  return createHash('sha256').update(model).update('\0').update(text).digest('hex')
}
