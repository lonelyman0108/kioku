import type { DatabaseCheck, RuntimeFamily } from '@kioku/contracts'

import type { SetupGate } from '../auth/setupCode'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import type { Jobs } from '../jobs/queue'

export interface SetupHost {
  gate: SetupGate
  migrationsFolder: string
  masterKey: boolean
  database(): {
    state: 'missing' | 'unavailable' | 'ready'
    source: 'env' | 'file' | null
    url: string | null
    check: DatabaseCheck | null
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  activate(url: string): Promise<'switched'>
}

export interface Deps {
  db: Db
  cookieSecure: boolean
  masterKey: MasterKey | null
  trustedProxies?: number
  webDir?: string
  jobs: Jobs | null
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
  name: string
  prefix: string
  runtimeFamily: RuntimeFamily
  envs: readonly string[]
  allowedRealms: readonly string[] | null
  focusRealms?: readonly string[] | null
  canWrite: boolean
  canResolveCredentials: boolean
}

export interface AppEnv {
  Variables: {
    console: ConsolePrincipal
    key: KeyPrincipal
  }
}
