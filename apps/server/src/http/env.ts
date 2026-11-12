import type {
  AppConfig,
  DatabaseCheck,
  DatabaseSource,
  DatabaseState,
  KeyScopes,
} from '@kioku/contracts'

import type { SetupGate } from '../auth/setupCode'
import type { BenchLimits } from '../bench/rollback'
import type { VaultClient } from '../credential/bitwarden/types'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import type { EmbedderSource } from '../embedding/source'
import type { Jobs } from '../jobs/queue'

// 初始化用到的服务状态：初始化码、数据库从哪里来、接上了没有。没接上数据库时只有初始化的接口用它，
// 接上之后完整的服务也带着它（环境变量来源的库要在初始化页上先显示一遍）
export interface SetupHost {
  gate: SetupGate
  migrationsFolder: string
  // 是否配了主密钥
  masterKey: boolean
  database(): {
    state: DatabaseState
    source: DatabaseSource | null
    url: string | null
    // 暂时连不上时最近一次检查的结果（定时重试时更新），初始化状态按它报原因，不另外探测
    check: DatabaseCheck | null
  }
  // 同一时刻只做一件改数据库的事（检查之后的代建、接入）；已经在做时抛 SetupBusyError
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  // 保存连接并当场接上，分两段：准备（起完整的服务、数账号、写 kioku.json）可能失败，失败时抛 ActivationError，
  // 起到一半的都关掉、状态不变；切换（换上完整的接口、开关初始化码）不会失败。
  // 只有 ActivationError 表示没有接上：调用方据此决定能不能回滚（例如删掉代建的库），别的错误一律当作已经切换
  activate(url: string): Promise<'switched'>
}

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
  // 初始化码与数据库状态。不设时（测试）不核对初始化码，状态按已接上的库算
  setup?: SetupHost
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
