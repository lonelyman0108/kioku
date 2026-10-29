import type { ChatMessage, ChatModel } from '../extraction/provider'

// 测试用的抽取模型：记下收到的消息，按给定的内容（或按消息算出的内容）回答，用量固定
export function fakeChatModel(
  reply: string | ((messages: ChatMessage[]) => string | Promise<string>),
  usage = { promptTokens: 120, completionTokens: 30 },
) {
  const calls: ChatMessage[][] = []
  const model: ChatModel = {
    model: 'fake-model',
    async complete(messages) {
      calls.push(messages)
      const content = typeof reply === 'function' ? await reply(messages) : reply
      return { content, usage }
    },
  }
  return { model, calls }
}

// Dream 的请求里给模型看的一条记忆（「## 记忆」下面每行一个 JSON 对象）
export interface DreamLine {
  id: string
  new: boolean
  kind: 'node' | 'fact' | 'summary'
  uri?: string
  subject?: string
  trusted?: boolean
  visibility?: string
  updated: string
  truncated?: boolean
  content: string
}

export function dreamLines(messages: ChatMessage[]): DreamLine[] {
  const user = messages.find((m) => m.role === 'user')?.content ?? ''
  const marker = '## 记忆\n'
  const at = user.indexOf(marker)
  if (at < 0) return []
  return user
    .slice(at + marker.length)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DreamLine)
}

// 按正文找这次请求里的代号；没给模型看的为 undefined
export function handleOf(messages: ChatMessage[], content: string): string | undefined {
  return dreamLines(messages).find((line) => line.content === content)?.id
}
