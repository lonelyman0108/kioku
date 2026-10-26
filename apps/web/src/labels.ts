import type { Layer, Sensitivity } from '@kioku/contracts'

export const layerLabels: Record<Layer, string> = {
  base: '基础',
  persona: '人格',
  app: '应用',
  owner: '主人画像',
  private: '私人',
  subject: '对象',
  episode: '情节',
}

export const sensitivityLabels: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}

// 按 URI 直接新建时可选的层：persona:// 与 app:// 由 URI 决定，对象与情节层由对话抽取写入
export const creatableLayers: Layer[] = ['base', 'owner', 'private']

export const sensitivityColors: Record<Sensitivity, 'neutral' | 'info' | 'warning' | 'error'> = {
  public: 'neutral',
  internal: 'info',
  private: 'warning',
  secret: 'error',
}
