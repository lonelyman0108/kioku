import type { AppConfig, KeyScopes } from '@kioku/contracts'

import type { Db } from '../db/client'

export interface Deps {
  db: Db
  cookieSecure: boolean
  // 没配置时不能读写 secret 级记忆
  masterKey: Buffer | null
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
