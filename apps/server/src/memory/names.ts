import { LAYER_NAMES, SENSITIVITY_NAMES, type Layer, type Sensitivity } from '@kioku/contracts'

// 错误信息也给 Key 调用方（MCP、REST）时写成中文名加取值，调用方对得上参数。只给界面的直接用中文名
export const layerWithValue = (layer: Layer) => `${LAYER_NAMES[layer]}层（${layer}）`
export const sensitivityWithValue = (sensitivity: Sensitivity) =>
  `${SENSITIVITY_NAMES[sensitivity]}级（${sensitivity}）`
