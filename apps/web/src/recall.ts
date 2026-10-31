import type { AppRecallVolume, DebugCandidate, RecallSource } from '@kioku/contracts'

import { recallSourceLabels } from './labels'

// 召回页的计算：各应用的调用量、分数轴

// 一个应用的调用量条里的一段：按来路分，占这个应用总量的比例
export interface VolumeSegment {
  source: RecallSource
  label: string
  count: number
  share: number
}

export interface VolumeBar {
  volume: AppRecallVolume
  // 条长，占最长一条的百分比
  width: number
  segments: VolumeSegment[]
}

// 段的先后固定：每轮输入最多，放最前面，各应用之间能对着看
const SOURCE_ORDER: RecallSource[] = ['prompt.submit', 'session.start', 'mcp.search', 'rest.recall']

// 条长按调用量的平方根：几十倍的差距下小应用也看得清，确切的次数写在旁边
export function volumeBars(apps: readonly AppRecallVolume[]): VolumeBar[] {
  const longest = Math.sqrt(Math.max(0, ...apps.map((app) => app.total)))
  return apps.map((volume) => ({
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

// 调用次数加起来：只有当前账号能管 Key 的应用，服务端只给这些
export const recallTotal = (apps: readonly AppRecallVolume[]) =>
  apps.reduce((sum, app) => sum + app.total, 0)

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

// 四路的得分，四项相加就是总分。没走到的一路 value 是 0，文字写「–」，条上不画
export function scoreParts(candidate: DebugCandidate): ScorePart[] {
  const { semantic, fulltext, glossary, priority } = candidate.breakdown
  const sum = semantic + fulltext + glossary + priority
  return [
    { label: '向量', value: semantic },
    { label: '全文', value: fulltext },
    { label: '关键词', value: glossary },
    { label: '优先级', value: priority },
  ].map((part) => ({ ...part, share: sum ? (part.value / sum) * 100 : 0 }))
}
