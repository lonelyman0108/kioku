import { describe, expect, it } from 'vitest'

import {
  clampRailWidth,
  computeMaxRailWidth,
  estimateElasticRailWidth,
  parseStoredRailWidth,
  RAIL_CONTAINER_MIN,
  RAIL_ELASTIC_FALLBACK,
  RAIL_ELASTIC_MAX,
  RAIL_ELASTIC_MIN,
  RAIL_WIDTH_MAX,
  RAIL_WIDTH_MIN,
} from '../readRail'

describe('readRail 辅助轨尺寸换算', () => {
  it('parseStoredRailWidth 仅接受有效区间内的有限数字并四舍五入', () => {
    expect(parseStoredRailWidth(null)).toBeNull()
    expect(parseStoredRailWidth('')).toBeNull()
    expect(parseStoredRailWidth('abc')).toBeNull()
    expect(parseStoredRailWidth('NaN')).toBeNull()
    expect(parseStoredRailWidth(String(RAIL_WIDTH_MIN - 1))).toBeNull()
    expect(parseStoredRailWidth(String(RAIL_WIDTH_MAX + 1))).toBeNull()
    expect(parseStoredRailWidth('240')).toBe(240)
    expect(parseStoredRailWidth('333.6')).toBe(334)
    expect(parseStoredRailWidth('480')).toBe(480)
  })

  it('computeMaxRailWidth 直接基于 content-box 宽度计算上限，不重复扣除容器内边距', () => {
    expect(computeMaxRailWidth(0)).toBe(RAIL_WIDTH_MAX)
    expect(computeMaxRailWidth(-10)).toBe(RAIL_WIDTH_MAX)
    // 恰好达到 960px 宽屏门槛时：960 - 460(主栏下限) - 28(间距) = 472px
    expect(computeMaxRailWidth(RAIL_CONTAINER_MIN)).toBe(472)
    // 达到或超过 1320px 画布上限时封顶于 480px
    expect(computeMaxRailWidth(1320)).toBe(RAIL_WIDTH_MAX)
    expect(computeMaxRailWidth(1920)).toBe(RAIL_WIDTH_MAX)
    // 极窄容器仍保底至最小轨宽 240px
    expect(computeMaxRailWidth(600)).toBe(RAIL_WIDTH_MIN)
  })

  it('clampRailWidth 将宽度约束在最小轨宽与动态上限之间', () => {
    expect(clampRailWidth(180, 400)).toBe(RAIL_WIDTH_MIN)
    expect(clampRailWidth(450, 400)).toBe(400)
    expect(clampRailWidth(320.4, 480)).toBe(320)
  })

  it('estimateElasticRailWidth 在未手动固定宽度时匹配 clamp(296px, 28cqi, 360px)', () => {
    expect(estimateElasticRailWidth(0)).toBe(RAIL_ELASTIC_FALLBACK)
    expect(estimateElasticRailWidth(960)).toBe(RAIL_ELASTIC_MIN)
    expect(estimateElasticRailWidth(1100)).toBe(308)
    expect(estimateElasticRailWidth(1320)).toBe(RAIL_ELASTIC_MAX)
    expect(estimateElasticRailWidth(1800)).toBe(RAIL_ELASTIC_MAX)
    // 窄于门槛时依然不突破动态上限
    expect(estimateElasticRailWidth(760)).toBe(272)
  })
})
