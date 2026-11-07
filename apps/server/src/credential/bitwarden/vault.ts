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

// 把同步与取条目的响应解成 VaultSnapshot 与 VaultItem。概况只解名称与字段名，值只在 decodeItem 里解开。
// 条目、集合按代码表查的键都来自服务端，用 Map 查：constructor、__proto__ 这类名字不会被当成认识的

const ROLES = new Map<unknown, VaultOrganizationRole>([
  [0, 'owner'],
  [1, 'admin'],
  [2, 'user'],
  [3, 'manager'],
  [4, 'custom'],
])

const TYPES = new Map<unknown, VaultItemType>([
  [1, 'login'],
  [2, 'note'],
  [3, 'card'],
  [4, 'identity'],
  [5, 'ssh_key'],
])

// 同步之后留在会话内存里的：组织密钥按组织 id；解不开的组织密钥记下当时的错误，取它的条目时照样报
export interface SyncedState {
  snapshot: VaultSnapshot
  orgKeys: Map<string, SymmetricKey>
  orgKeyErrors: Map<string, VaultError>
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function role(type: unknown): VaultOrganizationRole {
  const known = ROLES.get(type)
  // 不认识的角色不能当作普通成员：凭据服务按角色拒绝连接
  if (!known) throw badResponse('unknown organization role')
  return known
}

// 自定义角色里这几项权限等于看得到全部集合：编辑、删除任何集合；导出能拿到整个组织；管理成员、群组能给自己加权限
const ALL_COLLECTION_PERMISSIONS = [
  'accessImportExport',
  'editAnyCollection',
  'deleteAnyCollection',
  'manageGroups',
  'manageUsers',
]

// 看得到组织里全部的集合：所有者、管理员；旧版的「访问全部集合」（accessAll，profile 里有这一项时）；上面那几项权限。
// Vaultwarden 的 access_all（直接设的或经群组给的）不在 profile 里，这里看不到
function allCollections(org: unknown, orgRole: VaultOrganizationRole): boolean {
  if (orgRole === 'owner' || orgRole === 'admin') return true
  if (prop(org, 'accessAll') === true) return true
  const permissions = prop(org, 'permissions')
  return ALL_COLLECTION_PERMISSIONS.some((name) => prop(permissions, name) === true)
}

// 解开一个条目或集合时出的错：格式不认识、校验不过、缺字段，都只让这一个不可读
function unreadable(err: unknown): err is VaultError {
  return (
    err instanceof VaultError &&
    (err.kind === 'integrity' || err.kind === 'unsupported_format' || err.kind === 'server_error')
  )
}

export function decodeSync(json: unknown, userKey: SymmetricKey): SyncedState {
  const profile = prop(json, 'profile')
  const account: VaultAccount = {
    userId: requireStr(profile, 'id'),
    email: requireStr(profile, 'email'),
  }

  const orgKeys = new Map<string, SymmetricKey>()
  const orgKeyErrors = new Map<string, VaultError>()
  let privateKey: Buffer | null = null
  let privateKeyError: VaultError | null = null
  const privateKeyEnc = str(profile, 'privateKey')
  if (privateKeyEnc) {
    try {
      privateKey = decryptBytes(privateKeyEnc, userKey)
    } catch (err) {
      if (!unreadable(err)) throw err
      privateKeyError = err
    }
  }
  const organizations: VaultSnapshot['organizations'] = []
  for (const org of list(prop(profile, 'organizations'))) {
    const id = requireStr(org, 'id')
    const orgRole = role(prop(org, 'type'))
    organizations.push({
      id,
      name: str(org, 'name') ?? '',
      role: orgRole,
      allCollections: allCollections(org, orgRole),
    })
    // 还没被确认的成员没有组织密钥，读不到组织里的东西
    const key = str(org, 'key')
    if (!key) continue
    if (privateKeyError) {
      orgKeyErrors.set(id, privateKeyError)
      continue
    }
    // 组织有密钥、profile 却没有私钥：解不开，记下来，取这个组织的条目时不再反复重新同步
    if (!privateKey) {
      orgKeyErrors.set(id, new VaultError('unsupported_format', '缺少账户私钥，无法解开组织密钥'))
      continue
    }
    try {
      orgKeys.set(id, splitKey(decryptRsa(key, privateKey)))
    } catch (err) {
      if (!unreadable(err)) throw err
      orgKeyErrors.set(id, err)
    }
  }

  const collections: VaultSnapshot['collections'] = []
  for (const col of list(prop(json, 'collections'))) {
    try {
      const organizationId = requireStr(col, 'organizationId')
      const key = orgKeys.get(organizationId)
      if (!key) continue
      collections.push({
        id: requireStr(col, 'id'),
        organizationId,
        name: decryptText(requireStr(col, 'name'), key),
      })
    } catch (err) {
      // 解不开的集合不列；它里面的条目照样按条目自己的情况算
      if (!unreadable(err)) throw err
    }
  }

  let personalItemCount = 0
  let unreadableItemCount = 0
  const items: VaultItemSummary[] = []
  for (const cipher of list(prop(json, 'ciphers'))) {
    if (prop(cipher, 'deletedDate')) continue
    const organizationId = str(cipher, 'organizationId')
    if (!organizationId) {
      personalItemCount++
      continue
    }
    // 组织密钥解不开（或者不在手里）时，这个组织的条目都算解不开
    const orgKey = orgKeys.get(organizationId)
    if (!orgKey) {
      unreadableItemCount++
      continue
    }
    try {
      items.push(decodeCipher(cipher, orgKey, false).summary)
    } catch (err) {
      if (!unreadable(err)) throw err
      unreadableItemCount++
    }
  }

  return {
    snapshot: {
      account,
      organizations,
      collections,
      personalItemCount,
      items,
      unreadableItemCount,
    },
    orgKeys,
    orgKeyErrors,
  }
}

const isEnc = (value: unknown): value is string => typeof value === 'string' && value !== ''

// 解一个组织里的条目。withValues 为 false 时只解名称与字段名。
// 卡片、身份、SSH 密钥的专有字段不解，这几类只有备注与自定义字段
function decodeCipher(
  cipher: unknown,
  orgKey: SymmetricKey,
  withValues: boolean,
): { summary: VaultItemSummary; values: Record<VaultFieldRef, string> } {
  // 有的服务端把类型写成整数形式的字符串（"1"）；别的字符串照样认不出
  const raw = prop(cipher, 'type')
  const type = TYPES.get(typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : raw)
  if (!type) throw new VaultError('unsupported_format', '不支持的条目类型')
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

// 取单个条目的响应。在回收站里、不属于组织或组织不在手里的，都算不可用；
// 组织密钥解不开时报当时的错误（integrity 或 unsupported_format），和条目本身解不开一样
export function decodeItem(json: unknown, state: SyncedState): VaultItem {
  if (prop(json, 'deletedDate')) throw unavailable()
  const organizationId = str(json, 'organizationId')
  if (!organizationId) throw unavailable()
  const keyError = state.orgKeyErrors.get(organizationId)
  if (keyError) throw new VaultError(keyError.kind, keyError.message)
  const orgKey = state.orgKeys.get(organizationId)
  if (!orgKey) throw unavailable()
  const decoded = decodeCipher(json, orgKey, true)
  return { ...decoded.summary, values: decoded.values }
}

// 同步响应里组织条目的值：和 decodeSync 读同一份响应、用同一份组织密钥，算哪些条目的规则也一样
// （回收站里的、个人条目、组织密钥不在手里的不算），解不开的跳过
export function decodeSyncItems(json: unknown, state: SyncedState): VaultItem[] {
  const items: VaultItem[] = []
  for (const cipher of list(prop(json, 'ciphers'))) {
    if (prop(cipher, 'deletedDate')) continue
    const organizationId = str(cipher, 'organizationId')
    const orgKey = organizationId ? state.orgKeys.get(organizationId) : undefined
    if (!orgKey) continue
    try {
      const decoded = decodeCipher(cipher, orgKey, true)
      items.push({ ...decoded.summary, values: decoded.values })
    } catch (err) {
      if (!unreadable(err)) throw err
    }
  }
  return items
}
