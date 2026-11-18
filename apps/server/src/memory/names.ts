import {
  CIRCLE_KIND_NAMES,
  ENTRY_KIND_NAMES,
  SENSITIVITY_NAMES,
  type CircleKind,
  type EntryKind,
  type Sensitivity,
} from '@kioku/contracts'

// 错误信息同时面向调用方（MCP、REST）与人时附上英文枚举取值，便于核对参数
export const kindWithValue = (kind: EntryKind) => `${ENTRY_KIND_NAMES[kind]}（${kind}）`
export const circleKindWithValue = (kind: CircleKind) => `${CIRCLE_KIND_NAMES[kind]}（${kind}）`
export const sensitivityWithValue = (sensitivity: Sensitivity) =>
  `${SENSITIVITY_NAMES[sensitivity]}级（${sensitivity}）`
