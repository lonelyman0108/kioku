import { randomBytes, randomUUID } from 'node:crypto'

import { isNewerRevision } from '@kioku/contracts'

import {
  VaultError,
  VaultFieldError,
  type VaultClient,
  type VaultErrorKind,
  type VaultItem,
  type VaultItemType,
  type VaultOrganizationRole,
  type VaultSecrets,
  type VaultSnapshot,
  type VaultTwoFactorProvider,
  type VaultUpdated,
} from '../credential/bitwarden/types'

// 测试用的密码库客户端：账号、条目与组织都在内存里，能按需模拟各种 VaultError，
// 每次新建的会话第一次调用时、以及每次 snapshot() 都同步一次（触发 onSynced），也能让会话换一次刷新令牌（触发 onSecretsChanged）。
// 写入照真的客户端的约定：每次改动条目的修改时间往后走；目标集合只读或不在集合列表里报 read_only；
// 修改时条目的修改时间比期望的晚 1 秒以上报 item_conflict（修改时间每次往后走 1 秒，正好够）；
// 写不认识的字段（含 login.totp）报 VaultFieldError；改密码与隐藏字段时旧值进条目的密码历史；
// 值超过 maxValueLength 时报 value_too_long；值都没变时不改、修改时间不动，changed 为 false

export interface FakeVaultItem {
  id?: string
  name: string
  type?: VaultItemType
  values: Record<string, string>
  collectionId?: string
}

// 条目在假密码库里的样子：修改时间、所在集合、网址与密码历史（被改掉的密码与隐藏字段的旧值）
interface StoredItem {
  id: string
  name: string
  type: VaultItemType
  values: Record<string, string>
  collectionId: string
  revisionDate: string
  uris: { uri: string; autofill: boolean }[]
  history: { field: string; value: string }[]
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
  // 在别处（浏览器里）改了条目：值整个换掉，修改时间往后走
  setItemValues(id: string, values: Record<string, string>): void
  // 条目现在的样子（核对写回用）
  stored(id: string): StoredItem | undefined
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
    // 每次取条目（item 与 items）之前调用一次（用完就清掉），测试用它在取用的第二段里模拟别的进程
    beforeItem: (() => Promise<void>) | null
    // 每次同步之前调用一次（用完就清掉），和 beforeItem 一样
    beforeSnapshot: (() => Promise<void>) | null
    // 登录前等它（用完就清掉），测试用它让一次登录停在半路
    beforeLogin: Promise<void> | null
    // 换过刷新令牌之后，新的这个马上失效：同一次调用里先换令牌、后报 reauth_required
    revokeAfterRotate: boolean
    // 同步之后不交给 onSynced：模拟没有在 onSynced 里检查的客户端
    skipOnSynced: boolean
    // 账号读得到的集合：readOnly 的写不进去
    collections: { id: string; name: string; readOnly: boolean }[]
    // 写入时单个值的长度上限：超了报 value_too_long；null 不限
    maxValueLength: number | null
    // 每次写入（createItem、updateItem）之前调用一次（用完就清掉）：测试用它模拟写入期间的并发
    beforeWrite: (() => Promise<void>) | null
  }
  calls: {
    login: number
    snapshot: number
    item: number
    items: number
    sessions: number
    createItem: number
    updateItem: number
  }
  // 每个会话最近一次用的刷新令牌
  refreshTokens: string[]
}

export const FAKE_ORG = 'org-1'
export const FAKE_COLLECTION = 'col-1'
const ORG = FAKE_ORG
const COLLECTION = FAKE_COLLECTION

// 客户端写得进去的字段：用户名、密码、备注与自定义字段（写成隐藏字段）
const writable = (ref: string) =>
  ref === 'login.username' ||
  ref === 'login.password' ||
  ref === 'notes' ||
  ref.startsWith('field:')
// 改了值时旧值进密码历史的字段：密码与隐藏字段（同官方客户端）
const historied = (ref: string) => ref === 'login.password' || ref.startsWith('field:')
// 写入的错误种类里有客户端新加的 value_too_long
const VALUE_TOO_LONG = 'value_too_long' as VaultErrorKind

export function fakeVault(): FakeVault {
  const accounts = new Map<string, FakeAccount>()
  const items = new Map<string, StoredItem>()
  let failure: VaultErrorKind | null = null
  let pendingSync = false
  let pendingRotate = false
  let clock = Date.parse('2026-11-01T00:00:00.000Z')
  const nextRevision = () => new Date((clock += 1000)).toISOString()
  const calls = {
    login: 0,
    snapshot: 0,
    item: 0,
    items: 0,
    sessions: 0,
    createItem: 0,
    updateItem: 0,
  }
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
    collections: [{ id: COLLECTION, name: 'Agent', readOnly: false }],
    maxValueLength: null,
    beforeWrite: null,
  }

  const summary = (item: StoredItem) => ({
    id: item.id,
    organizationId: ORG,
    collectionIds: [item.collectionId],
    name: item.name,
    type: item.type,
    fields: Object.keys(item.values).filter((k) => item.values[k] !== ''),
    revisionDate: item.revisionDate,
  })

  const snapshot = (email: string, userId: string): VaultSnapshot => ({
    account: { userId, email },
    organizations: state.organizations,
    collections: state.collections.map((c) => ({ ...c, organizationId: ORG })),
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
        // 和真的客户端一样同步一次（交给 onSynced），给出全部条目的值
        async items(): Promise<VaultItem[]> {
          calls.items++
          const hook = state.beforeItem
          state.beforeItem = null
          await hook?.()
          await prelude(true)
          return [...items.values()].map((item) => ({
            ...summary(item),
            values: { ...item.values },
          }))
        },
        async createItem(input): Promise<VaultItem> {
          calls.createItem++
          await beforeWrite()
          await prelude()
          checkWrite(input.collectionId, input.values, input.type)
          const id = randomUUID()
          const item: StoredItem = {
            id,
            name: input.name,
            type: input.type,
            values: { ...input.values },
            collectionId: input.collectionId,
            revisionDate: nextRevision(),
            uris: input.uris ? [...input.uris] : [],
            history: [],
          }
          items.set(id, item)
          return { ...summary(item), values: { ...item.values } }
        },
        async updateItem(id, changes, expectedRevisionDate): Promise<VaultUpdated> {
          calls.updateItem++
          await beforeWrite()
          await prelude()
          const item = items.get(id)
          if (!item) throw new VaultError('item_unavailable', '条目不可用')
          if (isNewerRevision(item.revisionDate, expectedRevisionDate)) {
            throw new VaultError('item_conflict', '条目已在别处修改')
          }
          checkWrite(item.collectionId, changes.values ?? {}, item.type)
          // 和真的客户端一样，值都和原来相同时不发修改：原样返回，修改时间不变
          const same =
            Object.entries(changes.values ?? {}).every(([ref, v]) => item.values[ref] === v) &&
            (changes.name === undefined || changes.name === item.name)
          if (same)
            return { item: { ...summary(item), values: { ...item.values } }, changed: false }
          for (const [ref, value] of Object.entries(changes.values ?? {})) {
            const old = item.values[ref]
            if (historied(ref) && old !== undefined && old !== '' && old !== value) {
              item.history.push({ field: ref, value: old })
            }
            item.values[ref] = value
          }
          if (changes.name !== undefined) item.name = changes.name
          item.revisionDate = nextRevision()
          return { item: { ...summary(item), values: { ...item.values } }, changed: true }
        },
      }
    },
  }

  async function beforeWrite() {
    const hook = state.beforeWrite
    state.beforeWrite = null
    await hook?.()
  }

  // 写入前的检查，和真的客户端同一个顺序：集合能不能写、字段认不认得、值长不长
  // 登录条目才有 login.* 字段：往别的类型里写用户名、密码时，和不认识的字段一样报 VaultFieldError
  function checkWrite(collectionId: string, values: Record<string, string>, type: VaultItemType) {
    const collection = state.collections.find((c) => c.id === collectionId)
    if (!collection || collection.readOnly) throw new VaultError('read_only', '集合只读或不可用')
    for (const [ref, value] of Object.entries(values)) {
      if (!writable(ref) || (ref.startsWith('login.') && type !== 'login')) {
        throw new VaultFieldError('不支持写入这个字段')
      }
      if (state.maxValueLength !== null && value.length > state.maxValueLength) {
        throw new VaultError(VALUE_TOO_LONG, '值超出密码库的长度上限')
      }
    }
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
      items.set(id, {
        id,
        name: item.name,
        type: item.type ?? 'login',
        values: { ...item.values },
        collectionId: item.collectionId ?? COLLECTION,
        revisionDate: nextRevision(),
        uris: [],
        history: [],
      })
      return id
    },
    removeItem(id) {
      items.delete(id)
    },
    setItemValues(id, values) {
      const item = items.get(id)
      if (item) {
        item.values = { ...values }
        item.revisionDate = nextRevision()
      }
    },
    stored(id) {
      return items.get(id)
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
