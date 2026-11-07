import { decryptBytes, decryptRsa, decryptText, splitKey, type SymmetricKey } from './crypto'
import { badResponse, prop, requireStr, str } from './http'
import {
  VaultError,
  type VaultAccount,
  type VaultFieldRef,
  type VaultItem,
  type VaultItemSummary,
  type VaultItemType,
  type VaultOrganizationRole,
  type VaultSnapshot,
} from './types'

// 把同步与取条目的响应解成 VaultSnapshot 与 VaultItem。概况只解名称与字段名，值只在 decodeItem 里解开

const ROLES: Record<number, VaultOrganizationRole> = {
  0: 'owner',
  1: 'admin',
  2: 'user',
  3: 'manager',
  4: 'custom',
}

const TYPES: Record<number, VaultItemType> = {
  1: 'login',
  2: 'note',
  3: 'card',
  4: 'identity',
  5: 'ssh_key',
}

// 同步之后留在会话内存里的：组织密钥按组织 id
export interface SyncedState {
  snapshot: VaultSnapshot
  orgKeys: Map<string, SymmetricKey>
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function role(type: unknown): VaultOrganizationRole {
  const known = typeof type === 'number' ? ROLES[type] : undefined
  // 不认识的角色不能当作普通成员：凭据服务按角色拒绝连接
  if (!known) throw badResponse()
  return known
}

export function decodeSync(json: unknown, userKey: SymmetricKey): SyncedState {
  const profile = prop(json, 'profile')
  const account: VaultAccount = {
    userId: requireStr(profile, 'id'),
    email: requireStr(profile, 'email'),
  }

  const orgKeys = new Map<string, SymmetricKey>()
  const privateKeyEnc = str(profile, 'privateKey')
  const privateKey = privateKeyEnc ? decryptBytes(privateKeyEnc, userKey) : null
  const organizations: VaultSnapshot['organizations'] = []
  for (const org of list(prop(profile, 'organizations'))) {
    const id = requireStr(org, 'id')
    organizations.push({ id, name: str(org, 'name') ?? '', role: role(prop(org, 'type')) })
    // 还没被确认的成员没有组织密钥，读不到组织里的东西
    const key = str(org, 'key')
    if (key && privateKey) orgKeys.set(id, splitKey(decryptRsa(key, privateKey)))
  }

  const collections: VaultSnapshot['collections'] = []
  for (const col of list(prop(json, 'collections'))) {
    const organizationId = requireStr(col, 'organizationId')
    const key = orgKeys.get(organizationId)
    if (!key) continue
    collections.push({
      id: requireStr(col, 'id'),
      organizationId,
      name: decryptText(requireStr(col, 'name'), key),
    })
  }

  let personalItemCount = 0
  const items: VaultItemSummary[] = []
  for (const cipher of list(prop(json, 'ciphers'))) {
    if (prop(cipher, 'deletedDate')) continue
    const organizationId = str(cipher, 'organizationId')
    if (!organizationId) {
      personalItemCount++
      continue
    }
    const orgKey = orgKeys.get(organizationId)
    if (!orgKey) continue
    const decoded = decodeCipher(cipher, orgKey, false)
    if (decoded) items.push(decoded.summary)
  }

  return {
    snapshot: { account, organizations, collections, personalItemCount, items },
    orgKeys,
  }
}

const isEnc = (value: unknown): value is string => typeof value === 'string' && value !== ''

// 解一个组织里的条目。withValues 为 false 时只解名称与字段名；不认识的条目类型返回 null
function decodeCipher(
  cipher: unknown,
  orgKey: SymmetricKey,
  withValues: boolean,
): { summary: VaultItemSummary; values: Record<VaultFieldRef, string> } | null {
  const type = TYPES[prop(cipher, 'type') as number]
  if (!type) return null
  // 条目自己的密钥：有的话条目里的内容都用它加密，它本身用组织密钥加密
  const itemKeyEnc = str(cipher, 'key')
  const key = itemKeyEnc ? splitKey(decryptBytes(itemKeyEnc, orgKey)) : orgKey

  const fields: VaultFieldRef[] = []
  const values: Record<VaultFieldRef, string> = {}
  const add = (ref: VaultFieldRef, enc: unknown) => {
    if (!isEnc(enc) || fields.includes(ref)) return
    fields.push(ref)
    if (withValues) values[ref] = decryptText(enc, key)
  }
  if (type === 'login') {
    const login = prop(cipher, 'login')
    add('login.username', prop(login, 'username'))
    add('login.password', prop(login, 'password'))
    add('login.totp', prop(login, 'totp'))
  }
  add('notes', prop(cipher, 'notes'))
  for (const field of list(prop(cipher, 'fields'))) {
    const name = prop(field, 'name')
    if (!isEnc(name)) continue
    add(`field:${decryptText(name, key)}`, prop(field, 'value'))
  }

  const summary: VaultItemSummary = {
    id: requireStr(cipher, 'id'),
    organizationId: requireStr(cipher, 'organizationId'),
    collectionIds: list(prop(cipher, 'collectionIds')).filter(
      (id): id is string => typeof id === 'string',
    ),
    name: decryptText(requireStr(cipher, 'name'), key),
    type,
    fields,
    revisionDate: requireStr(cipher, 'revisionDate'),
  }
  return { summary, values }
}

const unavailable = () => new VaultError('item_unavailable', '条目不可用')

// 取单个条目的响应。在回收站里、不属于组织或组织密钥不在手里的，都算不可用
export function decodeItem(json: unknown, orgKeys: Map<string, SymmetricKey>): VaultItem {
  if (prop(json, 'deletedDate')) throw unavailable()
  const organizationId = str(json, 'organizationId')
  const orgKey = organizationId ? orgKeys.get(organizationId) : undefined
  if (!orgKey) throw unavailable()
  const decoded = decodeCipher(json, orgKey, true)
  if (!decoded) throw new VaultError('unsupported_format', '不支持的条目类型')
  return { ...decoded.summary, values: decoded.values }
}
