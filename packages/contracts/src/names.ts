import type { Layer, Sensitivity } from './memory'

// 层与敏感级的中文名，管理界面和服务端的错误信息共用一份，用词才不会分叉。
// 契约只放 zod schema，这里是例外，和 bench.ts 的 isReplayStep、mayWrite 一样
export const LAYER_NAMES: Record<Layer, string> = {
  base: '基础',
  persona: '人格',
  app: '应用',
  owner: '个人画像',
  private: '私人',
  subject: '联系人',
  episode: '情节',
}

export const SENSITIVITY_NAMES: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}
