import type { AppInfo, KeyInfo } from '@kioku/contracts'

// 测试台的共享逻辑：谁能用、真实模式的后果

// 只有应用主人能用测试台（会读到主人的私人层，空间 owner 也不行），所以只列自己是主人的应用
export const ownedApps = (apps: readonly AppInfo[], accountId: string | undefined) =>
  apps.filter((app) => app.ownerAccountId === accountId)

// 只能用还有效的 Key：吊销的、主人离开过空间而作废的都不列
export const usableKeys = (keys: readonly KeyInfo[]) => keys.filter((key) => key.effectiveScopes)

// 切到真实模式、在真实模式下运行场景之前都列出这些后果，由用户确认
export const REAL_MODE_CONSEQUENCES = [
  '写入是真的：步骤和这把 Key 的真实调用一样落库，不回滚，排向量与抽取任务。',
  '新建的对象没有删除接口，只能合并：带私聊、群聊或频道上下文的步骤，第一次见到的平台账号会新建对象。',
  'turn.end 会把这一轮放进对话缓冲，攒批之后排抽取（要花模型的 token，抽取的事实写进对象层）。',
  '写下的事件带「测试台」标记与你的账号，在活动和凭据的访问记录里看得到。',
] as const
