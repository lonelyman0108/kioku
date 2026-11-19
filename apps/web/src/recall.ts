import type {
  ClientInfo,
  ClientRecallVolume,
  DebugCandidate,
  KeyInfo,
  RecallSource,
} from '@kioku/contracts'

import { readFailure } from './api/client'
import { usableKeys } from './apps'
import { recallSourceLabels } from './labels'

// 召回页的计算：各接入实例的调用量、分数轴

// 调试能选的访问密钥：只来自传进来的接入实例（当前账号是所有者的），只要有效的。一个接入实例读取失败不影响别的，
// 失败的单独列出来；读到过又刷新失败的，手里的访问密钥照样能选。results 和 clients 一一对应
export function debugKeyChoices(
  clients: readonly ClientInfo[],
  results: readonly { data?: KeyInfo[] | undefined; isError: boolean; error: unknown }[],
) {
  return {
    options: clients.flatMap((client, i) =>
      usableKeys(results[i]?.data ?? []).map((key) => ({ client, key })),
    ),
    failures: clients.flatMap((client, i) => {
      const result = results[i]
      return result?.isError ? [{ client, text: readFailure(result.error) }] : []
    }),
  }
}

// 一个接入实例的调用量条里的一段：按来路分，占这个接入实例总量的比例
export interface VolumeSegment {
  source: RecallSource
  label: string
  count: number
  share: number
}

export interface VolumeBar {
  volume: ClientRecallVolume
  // 条长，占最长一条的百分比
  width: number
  segments: VolumeSegment[]
}

// 段的先后固定：每轮输入最多，放最前面，各接入实例之间能对着看
const SOURCE_ORDER: RecallSource[] = ['prompt.submit', 'session.start', 'mcp.search', 'rest.recall']

// 条长按调用量的平方根：几十倍的差距下小接入实例也看得清，确切的次数写在旁边
export function volumeBars(clients: readonly ClientRecallVolume[]): VolumeBar[] {
  const longest = Math.sqrt(Math.max(0, ...clients.map((client) => client.total)))
  return clients.map((volume) => ({
    volume,
    width: longest ? (Math.sqrt(volume.total) / longest) * 100 : 0,
    segments: SOURCE_ORDER.flatMap((source) => {
      const count = volume.sources.find((entry) => entry.source === source)?.count ?? 0
      return count
        ? [
            {
              source,
              label: recallSourceLabels[source],
              count,
              share: volume.total ? (count / volume.total) * 100 : 0,
            },
          ]
        : []
    }),
  }))
}

// 调用次数加起来：只有当前账号能管访问密钥的接入实例，服务端只给这些
export const recallTotal = (clients: readonly ClientRecallVolume[]) =>
  clients.reduce((sum, client) => sum + client.total, 0)

export interface ScoreAxis {
  max: number
  ticks: { value: number; left: number; label: string }[]
  threshold: number
}

const TICK = 0.25

// 分数轴：结果和阈值共用一根。分数是四路加起来的，可能超过 1，这时轴跟着放长，每格 0.25 不变
export function scoreAxis(scores: readonly number[], minScore: number): ScoreAxis {
  const max = Math.max(1, Math.ceil(Math.max(0, ...scores) / TICK) * TICK)
  const ticks: ScoreAxis['ticks'] = []
  for (let i = 0; i * TICK <= max; i++) {
    const value = i * TICK
    // 整数不带小数，和设计里的 0、1 一样
    ticks.push({
      value,
      left: (value / max) * 100,
      label: Number.isInteger(value) ? String(value) : value.toFixed(2),
    })
  }
  return { max, ticks, threshold: (minScore / max) * 100 }
}

export interface ScorePart {
  label: string
  value: number
  // 占这条分数条的比例
  share: number
}

// 六路的得分（向量、全文、关键词、优先级、切面、关联）。没走到的一路 value 是 0，负分（切面冲突惩罚）条上不占正比
export function scoreParts(candidate: DebugCandidate): ScorePart[] {
  const { semantic, fulltext, glossary, priority, facet, link } = candidate.breakdown
  const raw = [
    { label: '向量', value: semantic },
    { label: '全文', value: fulltext },
    { label: '关键词', value: glossary },
    { label: '优先级', value: priority },
    { label: '切面', value: facet },
    { label: '关联', value: link },
  ]
  const positiveSum = raw.reduce((acc, p) => acc + Math.max(0, p.value), 0)
  return raw.map((part) => ({
    ...part,
    share: part.value > 0 && positiveSum > 0 ? (part.value / positiveSum) * 100 : 0,
  }))
}
