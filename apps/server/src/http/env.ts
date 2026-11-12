import type { AppConfig, KeyScopes } from '@kioku/contracts'

import type { BenchLimits } from '../bench/rollback'
import type { VaultClient } from '../credential/bitwarden/types'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import type { EmbedderSource } from '../embedding/source'
import type { Jobs } from '../jobs/queue'
import type { UpdateCheckOptions } from '../settings/updateCheck'

export interface Deps {
  db: Db
  cookieSecure: boolean
  // 没配置时不能读写 secret 级记忆
  masterKey: MasterKey | null
  embedder: EmbedderSource
  // 前面受信任的反向代理层数，用来从 X-Forwarded-For 取客户端地址；默认 0（不信任转发头）
  trustedProxies?: number
  // 管理界面构建产物所在目录；不设置时只提供 API（开发时界面由 Vite 提供）
  webDir?: string
  // 没有后台任务时（例如部分测试）写入不触发向量更新
  jobs: Jobs | null
  // 连接密码库、取值用的客户端。不设时按连不上服务器处理（见 credential/vaultClient.ts），只有用到密码库的测试才给
  vault?: VaultClient
  // 按空间导出的文件发送的时限（毫秒）：多久没有进度就断开、最多发多久。不设时 2 分钟与 30 分钟（见 routes/spaces.ts）；
  // 测试里调小
  exportSendLimits?: { idleMs: number; totalMs: number }
  // 测试台回滚模式的时限与同时运行数，不设时见 bench/rollback.ts；测试里调小
  benchLimits?: Partial<BenchLimits>
  // 检查新版本时请求 GitHub 用的 fetch、当作当前版本的版本号与请求的时限。不设时用全局的 fetch、构建时写进产物的版本
  // 与 10 秒；测试里换掉
  updateCheck?: UpdateCheckOptions
}

export interface ConsolePrincipal {
  kind: 'console'
  accountId: string
  sessionId: string
}

export interface KeyPrincipal {
  kind: 'key'
  keyId: string
  spaceId: string
  scopes: KeyScopes
  app: {
    id: string
    slug: string
    name: string
    runtimeFamily: string
    ownerAccountId: string
    defaultPersonaId: string | null
    config: AppConfig
  }
}

export interface AppEnv {
  Variables: {
    console: ConsolePrincipal
    key: KeyPrincipal
  }
}
