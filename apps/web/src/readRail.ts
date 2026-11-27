// 记忆详情右侧辅助轨的尺寸边界与弹性宽度换算
export const RAIL_WIDTH_MIN = 240
export const RAIL_WIDTH_MAX = 480
export const RAIL_ELASTIC_MIN = 296
export const RAIL_ELASTIC_MAX = 360
export const RAIL_ELASTIC_RATIO = 0.28
export const RAIL_ELASTIC_FALLBACK = 320
export const RAIL_CONTAINER_MIN = 960
export const RAIL_CANVAS_MAX = 1320
export const RAIL_MAIN_MIN_WIDTH = 460
export const RAIL_GAP = 28

export function parseStoredRailWidth(raw: string | null): number | null {
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= RAIL_WIDTH_MIN && parsed <= RAIL_WIDTH_MAX
    ? Math.round(parsed)
    : null
}

// containerWidth 为滚动容器的 content-box 宽度（与 @container 基准一致，不含水平 padding）
export function computeMaxRailWidth(containerWidth: number): number {
  if (containerWidth <= 0) return RAIL_WIDTH_MAX
  const canvasWidth = Math.min(RAIL_CANVAS_MAX, containerWidth)
  return Math.max(
    RAIL_WIDTH_MIN,
    Math.min(RAIL_WIDTH_MAX, Math.floor(canvasWidth - RAIL_MAIN_MIN_WIDTH - RAIL_GAP)),
  )
}

export function clampRailWidth(width: number, maxWidth: number): number {
  return Math.max(RAIL_WIDTH_MIN, Math.min(maxWidth, Math.round(width)))
}

// 未持久化固定宽度时，按 CSS clamp(296px, 28cqi, 360px) 估算当前弹性轨宽供 ARIA 与回退使用
export function estimateElasticRailWidth(containerWidth: number): number {
  const maxWidth = computeMaxRailWidth(containerWidth)
  if (containerWidth <= 0) return clampRailWidth(RAIL_ELASTIC_FALLBACK, maxWidth)
  const elastic = Math.max(
    RAIL_ELASTIC_MIN,
    Math.min(RAIL_ELASTIC_MAX, containerWidth * RAIL_ELASTIC_RATIO),
  )
  return clampRailWidth(elastic, maxWidth)
}
