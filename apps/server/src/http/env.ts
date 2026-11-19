import type {
  CircleEffectiveGrant,
  CircleKind,
  ClientConfig,
  LensKeyScopes,
  WhenCondition,
} from '@kioku/contracts'

import type { SetupGate } from '../auth/setupCode'
import type { BenchLimits } from '../bench/rollback'
import type { VaultClient } from '../credential/bitwarden/types'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import type { EmbedderSource } from '../embedding/source'
import type { Jobs } from '../jobs/queue'
import type { UpdateCheckOptions } from '../settings/updateCheck'

export interface SetupHost {
  gate: SetupGate
  migrationsFolder: string
  masterKey: boolean
  database(): {
    state: 'missing' | 'unavailable' | 'ready'
    source: 'env' | 'file' | null
    url: string | null
    check: import('@kioku/contracts').DatabaseCheck | null
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  activate(url: string): Promise<'switched'>
}

export interface Deps {
  db: Db
  cookieSecure: boolean
  masterKey: MasterKey | null
  embedder: EmbedderSource
  trustedProxies?: number
  webDir?: string
  jobs: Jobs | null
  vault?: VaultClient
  exportSendLimits?: { idleMs: number; totalMs: number }
  benchLimits?: Partial<BenchLimits>
  setup?: SetupHost
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
  circleId: string
  scopes: LensKeyScopes
  contextFacets: WhenCondition
  staticContextRealms: ReadonlySet<string>
  personaOverrideId: string | null
  primaryCircle: {
    id: string
    slug: string
    name: string
    kind: CircleKind
    defaultRealms: readonly string[]
  }
  circleGrants: readonly CircleEffectiveGrant[]
  client: {
    id: string
    slug: string
    name: string
    runtimeFamily: string
    ownerAccountId: string
    defaultPersonaId: string | null
    config: ClientConfig
  }
  labels?: { circleName: string | null; accountName: string | null }
}

export interface AppEnv {
  Variables: {
    console: ConsolePrincipal
    key: KeyPrincipal
  }
}
