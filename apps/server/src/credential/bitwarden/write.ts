import { createHash } from 'node:crypto'

import { decryptBytes, decryptText, encryptText, splitKey, type SymmetricKey } from './crypto'
import { prop, str } from './http'
import {
  VaultError,
  type VaultFieldRef,
  type VaultItemChanges,
  type VaultItemType,
  type VaultNewItem,
} from './types'

// 新建与修改条目的请求体。值都加密成 EncString 类型 2。新条目不生成条目密钥，用组织密钥加密（官方客户端只在服务端
// 打开 cipher-key-encryption 时才生成，服务端都不要求）。修改从取到的原始条目复制，只换给了的字段的密文，
// 别的密文（通行密钥、密码历史、别的自定义字段、条目密钥）原样带回

const LOGIN = 1
const NOTE = 2
// 自定义字段的类型：0 文本、1 隐藏、2 布尔、3 关联（没有值，指向登录里的用户名或密码）
const HIDDEN_FIELD = 1
const LINKED_FIELD = 3
// 网址的匹配方式：1 主机加端口，5 不匹配
const MATCH_HOST = 1
const MATCH_NEVER = 5
// 官方客户端的密码历史最多留 5 条
const HISTORY_LIMIT = 5

type WriteRef =
  | { kind: 'login.username' }
  | { kind: 'login.password' }
  | { kind: 'notes' }
  | { kind: 'field'; name: string }

const unsupportedField = () => new VaultError('unsupported_format', '不支持写入这个字段')

// 写入能用的字段：login.totp 不收（验证码的密钥不由 Kioku 写），登录里的字段只给登录类
export function writeRef(ref: VaultFieldRef, type: VaultItemType | null): WriteRef {
  if (ref === 'notes') return { kind: 'notes' }
  if (ref === 'login.username' || ref === 'login.password') {
    if (type !== null && type !== 'login') throw unsupportedField()
    return { kind: ref }
  }
  if (ref.startsWith('field:') && ref.length > 'field:'.length) {
    return { kind: 'field', name: ref.slice('field:'.length) }
  }
  throw unsupportedField()
}

// 写入之前就检查：发请求之前报错，不留下写了一半的条目
export function checkNewItem(item: VaultNewItem): void {
  for (const ref of Object.keys(item.values)) writeRef(ref, item.type)
  if (item.type !== 'login' && item.uris?.length) throw unsupportedField()
}

export function checkChanges(changes: VaultItemChanges, type: VaultItemType | null): void {
  for (const ref of Object.keys(changes.values ?? {})) writeRef(ref, type)
}

const enc = (value: string, key: SymmetricKey) => encryptText(value, key)

// 网址的校验和：网址的 SHA-256 写成 base64 再加密。官方客户端解开带条目密钥的条目时按它核对网址
function uriEntry(uri: string, autofill: boolean, key: SymmetricKey) {
  const checksum = createHash('sha256').update(uri, 'utf8').digest('base64')
  return {
    uri: enc(uri, key),
    uriChecksum: enc(checksum, key),
    match: autofill ? MATCH_HOST : MATCH_NEVER,
  }
}

// POST /ciphers/create 的请求体：放进组织与一个集合。encryptedFor 是写入的账号（Vaultwarden 要求，官方服务核对它）
export function newCipherBody(item: VaultNewItem, orgKey: SymmetricKey, userId: string) {
  checkNewItem(item)
  let username: string | null = null
  let password: string | null = null
  let notes: string | null = null
  const fields: { type: number; name: string; value: string; linkedId: null }[] = []
  for (const [ref, value] of Object.entries(item.values)) {
    const target = writeRef(ref, item.type)
    if (target.kind === 'login.username') username = enc(value, orgKey)
    else if (target.kind === 'login.password') password = enc(value, orgKey)
    else if (target.kind === 'notes') notes = enc(value, orgKey)
    else {
      fields.push({
        type: HIDDEN_FIELD,
        name: enc(target.name, orgKey),
        value: enc(value, orgKey),
        linkedId: null,
      })
    }
  }
  const login = item.type === 'login'
  return {
    cipher: {
      type: login ? LOGIN : NOTE,
      organizationId: item.organizationId,
      folderId: null,
      encryptedFor: userId,
      key: null,
      name: enc(item.name, orgKey),
      notes,
      favorite: false,
      reprompt: 0,
      fields: fields.length ? fields : null,
      passwordHistory: null,
      lastKnownRevisionDate: null,
      login: login
        ? {
            username,
            password,
            totp: null,
            uris: (item.uris ?? []).map((u) => uriEntry(u.uri, u.autofill, orgKey)),
            passwordRevisionDate: null,
          }
        : null,
      secureNote: login ? null : { type: 0 },
    },
    collectionIds: [item.collectionId],
  }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isEnc = (value: unknown): value is string => typeof value === 'string' && value !== ''

// 写回原来的键：旧版 Vaultwarden 的 PascalCase 响应里没有 camelCase 的键时写到 PascalCase 上，不并存两份
function setProp(obj: Json, name: string, value: unknown): void {
  const pascal = name[0]!.toUpperCase() + name.slice(1)
  if (!Object.hasOwn(obj, name) && Object.hasOwn(obj, pascal)) obj[pascal] = value
  else obj[name] = value
}

function deleteProp(obj: Json, name: string): void {
  const pascal = name[0]!.toUpperCase() + name.slice(1)
  delete obj[name]
  delete obj[pascal]
}

// 对象里的一项：没有或不是对象时新建一个放进去
function childObject(obj: Json, name: string): Json {
  const value = prop(obj, name)
  if (isObject(value)) return value
  const created: Json = {}
  setProp(obj, name, created)
  return created
}

function childArray(obj: Json, name: string): unknown[] {
  const value = prop(obj, name)
  if (Array.isArray(value)) return value
  const created: unknown[] = []
  setProp(obj, name, created)
  return created
}

const fieldType = (field: Json) => Number(prop(field, 'type'))

export interface UpdateInput {
  // GET /ciphers/{id} 的响应，已经由 decodeItem 解开核对过
  raw: unknown
  type: VaultItemType
  changes: VaultItemChanges
  orgKey: SymmetricKey
  userId: string
  // 记进密码历史的时间
  now: string
}

// PUT /ciphers/{id} 的请求体。值和原来一样的字段不换密文。
// 密码历史照官方客户端：改了登录密码时旧密码（原来的密文）记进去，改了隐藏字段时记「名字: 旧值」，新的在前、最多 5 条；
// 旧值是空的不记。附件不带：响应里的附件是数组，请求里是按 id 的对象，官方服务认不出数组；不带时服务端两边都不动附件
export function updatedCipherBody(input: UpdateInput): Json {
  const { type, changes, orgKey, userId, now } = input
  checkChanges(changes, type)
  if (!isObject(input.raw)) throw unsupportedField()
  const body = structuredClone(input.raw)
  const itemKeyEnc = str(body, 'key')
  const key = itemKeyEnc ? splitKey(decryptBytes(itemKeyEnc, orgKey)) : orgKey
  const decrypt = (value: unknown) => (isEnc(value) ? decryptText(value, key) : null)

  if (changes.name !== undefined && decrypt(prop(body, 'name')) !== changes.name) {
    setProp(body, 'name', enc(changes.name, key))
  }

  let passwordEntry: Json | null = null
  const fieldEntries: Json[] = []
  for (const [ref, value] of Object.entries(changes.values ?? {})) {
    const target = writeRef(ref, type)
    if (target.kind === 'notes') {
      if (decrypt(prop(body, 'notes')) !== value) setProp(body, 'notes', enc(value, key))
      continue
    }
    if (target.kind === 'login.username') {
      const login = childObject(body, 'login')
      if (decrypt(prop(login, 'username')) !== value) setProp(login, 'username', enc(value, key))
      continue
    }
    if (target.kind === 'login.password') {
      const login = childObject(body, 'login')
      const old = prop(login, 'password')
      const oldPlain = decrypt(old)
      if (oldPlain === value) continue
      setProp(login, 'password', enc(value, key))
      if (oldPlain) {
        passwordEntry = { password: old, lastUsedDate: now }
        setProp(login, 'passwordRevisionDate', now)
      }
      continue
    }
    const fields = childArray(body, 'fields')
    const named = fields.filter(
      (f): f is Json => isObject(f) && decrypt(prop(f, 'name')) === target.name,
    )
    // 和读取时一样认第一个有值的同名字段；都没有值时取第一个不是关联字段的
    const field =
      named.find((f) => isEnc(prop(f, 'value'))) ?? named.find((f) => fieldType(f) !== LINKED_FIELD)
    if (!field) {
      fields.push({
        type: HIDDEN_FIELD,
        name: enc(target.name, key),
        value: enc(value, key),
        linkedId: null,
      })
      continue
    }
    const oldPlain = decrypt(prop(field, 'value'))
    if (oldPlain === value) continue
    setProp(field, 'value', enc(value, key))
    if (fieldType(field) === HIDDEN_FIELD && oldPlain) {
      fieldEntries.push({ password: enc(`${target.name}: ${oldPlain}`, key), lastUsedDate: now })
    }
  }

  // 官方客户端先插旧密码，再逐个插隐藏字段，都插在最前面
  const added = [...fieldEntries.reverse(), ...(passwordEntry ? [passwordEntry] : [])]
  if (added.length) {
    const existing = prop(body, 'passwordHistory')
    const history = [...added, ...(Array.isArray(existing) ? existing : [])]
    setProp(body, 'passwordHistory', history.slice(0, HISTORY_LIMIT))
  }

  deleteProp(body, 'attachments')
  setProp(body, 'lastKnownRevisionDate', str(body, 'revisionDate') ?? null)
  setProp(body, 'encryptedFor', userId)
  return body
}
