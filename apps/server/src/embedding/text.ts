import { createHash } from 'node:crypto'

export interface EmbeddableEntry {
  shortId: string
  title: string
  disclosure: string | null
  topics: readonly string[]
  envs: readonly string[]
  realms: readonly string[]
  projects: readonly string[]
  runtimes: readonly string[]
  content: string
}

// 拼接词条用于生成向量的文本，保持语义与场景标签完整
export function buildEmbeddingText(entry: EmbeddableEntry): string {
  const lines: string[] = [entry.title]
  if (entry.disclosure) lines.push(entry.disclosure)
  const tags = [
    ...entry.topics,
    ...entry.projects,
    ...entry.envs,
    ...entry.realms,
    ...entry.runtimes,
  ]
  if (tags.length) lines.push(tags.join(' '))
  lines.push(entry.content)
  return lines.join('\n').trim()
}

export function embeddingContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
