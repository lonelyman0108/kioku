import type { Layer, Sensitivity } from '@kioku/contracts'

// 错误信息里层与敏感级的叫法，和管理界面的用词一致。取值（owner、secret）只留在要调用方照着填的说明里
export const LAYER_NAMES: Record<Layer, string> = {
  base: '基础层',
  persona: '人格层',
  app: '应用层',
  owner: '个人画像层',
  private: '私人层',
  subject: '联系人层',
  episode: '情节层',
}

export const SENSITIVITY_NAMES: Record<Sensitivity, string> = {
  public: '公开',
  internal: '内部',
  private: '私密',
  secret: '机密',
}
