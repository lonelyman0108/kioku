import { createHash } from 'node:crypto'

import { EMBEDDING_DIMENSIONS } from '../db/schema'
import type { Embedder } from '../embedding/provider'

// 测试用的确定性嵌入：把字符二元组散列到各维度后归一化。字面重合越多余弦越大，足够验证检索流程
export function fakeEmbedder(model = 'fake-embedding'): Embedder & { calls: string[][] } {
  const calls: string[][] = []
  return {
    model,
    calls,
    async embed(texts) {
      calls.push(texts)
      return texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
        const chars = [...text.toLowerCase()]
        for (let i = 0; i < chars.length - 1; i++) {
          const h = createHash('md5')
            .update(chars[i]! + chars[i + 1]!)
            .digest()
          v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS]! += 1
        }
        const norm = Math.hypot(...v) || 1
        return v.map((x) => x / norm)
      })
    },
  }
}
