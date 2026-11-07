import { randomBytes, randomUUID } from 'node:crypto'

import {
  VaultError,
  type VaultClient,
  type VaultErrorKind,
  type VaultItem,
  type VaultItemType,
  type VaultOrganizationRole,
  type VaultSecrets,
  type VaultSnapshot,
  type VaultTwoFactorProvider,
} from '../credential/bitwarden/types'

// 测试用的密码库客户端：账号、条目与组织都在内存里，能按需模拟各种 VaultError，
// 每次新建的会话第一次调用时、以及每次 snapshot() 都同步一次（触发 onSynced），也能让会话换一次刷新令牌（触发 onSecretsChanged）

export interface FakeVaultItem {
  id?: string
  name: string
  type?: VaultItemType
  values: Record<string, string>
}

interface FakeAccount {
  password: string
  userId: string
  twoFactor?: { provider: VaultTwoFactorProvider; code: string }
}

export interface FakeVault {
  client: VaultClient
  addAccount(email: string, password: string, twoFactor?: FakeAccount['twoFactor']): string
  addItem(item: FakeVaultItem): string
  removeItem(id: string): void
  setItemValues(id: string, values: Record<string, string>): void
  // 下一次会话调用（snapshot 或 item）以这个错误失败
  failNext(kind: VaultErrorKind): void
  // 下一次会话调用之前先同步一次（像换了访问令牌）
  resync(): void
  // 下一次会话调用时会话换一个刷新令牌
  rotateSecrets(): void
  // 让一个刷新令牌失效：之后用它的会话报 reauth_required
  revokeToken(token: string): void
  // 给这个账号发一份新的令牌与账户密钥（像别的进程刚登录过）
  issueSecrets(email: string): VaultSecrets
  state: {
    personalItemCount: number
    organizations: {
      id: string
      name: string
      role: VaultOrganizationRole
      allCollections: boolean
    }[]
    unreadableItemCount: number
    loginFailure: VaultErrorKind | null
    // 每次取条目之前调用一次（用完就清掉），测试用它在取用的第二段里模拟别的进程
    beforeItem: (() => Promise<void>) | null
    // 每次同步之前调用一次（用完就清掉），和 beforeItem 一样
    beforeSnapshot: (() => Promise<void>) | null
    // 登录前等它（用完就清掉），测试用它让一次登录停在半路
    beforeLogin: Promise<void> | null
    // 换过刷新令牌之后，新的这个马上失效：同一次调用里先换令牌、后报 reauth_required
    revokeAfterRotate: boolean
    // 同步之后不交给 onSynced：模拟没有在 onSynced 里检查的客户端
    skipOnSynced: boolean
  }
  calls: { login: number; snapshot: number; item: number; sessions: number }
  // 每个会话最近一次用的刷新令牌
  refreshTokens: string[]
}

const ORG = 'org-1'
const COLLECTION = 'col-1'

export function fakeVault(): FakeVault {
  const accounts = new Map<string, FakeAccount>()
  const items = new Map<string, Required<FakeVaultItem>>()
  let failure: VaultErrorKind | null = null
  let pendingSync = false
  let pendingRotate = false
  const calls = { login: 0, snapshot: 0, item: 0, sessions: 0 }
  const refreshTokens: string[] = []
  const revoked = new Set<string>()
  const state: FakeVault['state'] = {
    personalItemCount: 0,
    organizations: [{ id: ORG, name: 'Kioku', role: 'user', allCollections: false }],
    unreadableItemCount: 0,
    loginFailure: null,
    beforeItem: null,
    beforeSnapshot: null,
    beforeLogin: null,
    revokeAfterRotate: false,
    skipOnSynced: false,
  }

  const summary = (item: Required<FakeVaultItem>) => ({
    id: item.id,
    organizationId: ORG,
    collectionIds: [COLLECTION],
    name: item.name,
    type: item.type,
    fields: Object.keys(item.values).filter((k) => item.values[k] !== ''),
    revisionDate: '2026-11-01T00:00:00.000Z',
  })

  const snapshot = (email: string, userId: string): VaultSnapshot => ({
    account: { userId, email },
    organizations: state.organizations,
    collections: [{ id: COLLECTION, organizationId: ORG, name: 'Agent' }],
    personalItemCount: state.personalItemCount,
    items: [...items.values()].map(summary),
    unreadableItemCount: state.unreadableItemCount,
  })

  const secretsFor = (email: string): VaultSecrets => ({
    refreshToken: `refresh-${email}-${randomUUID()}`,
    userKey: randomBytes(64),
  })

  const client: VaultClient = {
    async login(input) {
      calls.login++
      const waiting = state.beforeLogin
      state.beforeLogin = null
      await waiting
      if (state.loginFailure) throw new VaultError(state.loginFailure, '模拟的登录失败')
      const account = accounts.get(input.email)
      if (!account || account.password !== input.masterPassword) {
        throw new VaultError('invalid_credentials', '邮箱或主密码不对')
      }
      if (account.twoFactor) {
        if (!input.twoFactor) {
          return { kind: 'two_factor_required', providers: [account.twoFactor.provider] }
        }
        if (input.twoFactor.code !== account.twoFactor.code) {
          throw new VaultError('two_factor_invalid', '验证码不对')
        }
      }
      return {
        kind: 'ok',
        secrets: secretsFor(input.email),
        account: { userId: account.userId, email: input.email },
      }
    },
    session(input) {
      calls.sessions++
      let synced = false
      let secrets = input.secrets
      refreshTokens.push(secrets.refreshToken)
      const userId =
        [...accounts.entries()].find(([email]) => secrets.refreshToken.includes(email))?.[1]
          .userId ?? 'unknown'
      const email = [...accounts.keys()].find((e) => secrets.refreshToken.includes(e)) ?? ''
      // forSnapshot：snapshot() 自己就是一次同步，之后照样交给 onSynced
      const prelude = async (forSnapshot = false) => {
        if (revoked.has(secrets.refreshToken)) {
          throw new VaultError('reauth_required', '刷新令牌已失效')
        }
        if (failure) {
          const kind = failure
          failure = null
          throw new VaultError(kind, '模拟的密码库错误')
        }
        if (pendingRotate) {
          pendingRotate = false
          secrets = secretsFor(email)
          refreshTokens.push(secrets.refreshToken)
          await input.onSecretsChanged?.(secrets)
          if (state.revokeAfterRotate) {
            state.revokeAfterRotate = false
            revoked.add(secrets.refreshToken)
            throw new VaultError('reauth_required', '刷新令牌已失效')
          }
        }
        if (!synced || pendingSync || forSnapshot) {
          synced = true
          pendingSync = false
          if (!state.skipOnSynced) await input.onSynced?.(snapshot(email, userId))
        }
      }
      return {
        async snapshot() {
          calls.snapshot++
          const hook = state.beforeSnapshot
          state.beforeSnapshot = null
          await hook?.()
          await prelude(true)
          return snapshot(email, userId)
        },
        async item(id): Promise<VaultItem> {
          calls.item++
          const hook = state.beforeItem
          state.beforeItem = null
          await hook?.()
          await prelude()
          const item = items.get(id)
          if (!item) throw new VaultError('item_unavailable', '条目不可用')
          return { ...summary(item), values: { ...item.values } }
        },
      }
    },
  }

  return {
    client,
    addAccount(email, password, twoFactor) {
      const userId = randomUUID()
      accounts.set(email, { password, userId, ...(twoFactor ? { twoFactor } : {}) })
      return userId
    },
    addItem(item) {
      const id = item.id ?? randomUUID()
      items.set(id, { id, name: item.name, type: item.type ?? 'login', values: item.values })
      return id
    },
    removeItem(id) {
      items.delete(id)
    },
    setItemValues(id, values) {
      const item = items.get(id)
      if (item) item.values = values
    },
    failNext(kind) {
      failure = kind
    },
    resync() {
      pendingSync = true
    },
    rotateSecrets() {
      pendingRotate = true
    },
    revokeToken(token) {
      revoked.add(token)
    },
    issueSecrets(email) {
      return secretsFor(email)
    },
    state,
    calls,
    refreshTokens,
  }
}
