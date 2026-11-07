import { createHash } from 'node:crypto'

import { decryptBytes, decryptText, encryptText, splitKey, type SymmetricKey } from './crypto'
import { prop, str } from './http'
import {
  VaultError,
  VaultFieldError,
  type VaultFieldRef,
  type VaultItemType,
  type VaultNewItem,
} from './types'
import { isEnc, namedFields } from './vault'

// 新建与修改条目的请求体。值都加密成 EncString 类型 2。新条目不生成条目密钥，用组织密钥加密（官方客户端只在服务端
// 打开 cipher-key-encryption 时才生成，服务端都不要求）。修改从取到的原始条目复制，只换给了的字段的密文，
// 别的密文（通行密钥、密码历史、别的自定义字段、条目密钥）原样带回

const LOGIN = 1
const NOTE = 2
const HIDDEN_FIELD = 1
// 网址的匹配方式：1 主机加端口，5 不匹配
const MATCH_HOST = 1
const MATCH_NEVER = 5
// 官方客户端的密码历史最多留 5 条
const HISTORY_LIMIT = 5

type WriteTarget =
  | { kind: 'login.username' }
  | { kind: 'login.password' }
  | { kind: 'notes' }
  | { kind: 'field'; name: string }

export interface WriteValue {
  target: WriteTarget
  value: string
}

const unsupportedField = () => new VaultFieldError('不支持写入这个字段')

function writeTarget(ref: VaultFieldRef): WriteTarget {
  if (ref === 'notes' || ref === 'login.username' || ref === 'login.password') return { kind: ref }
  if (ref.startsWith('field:') && ref.length > 'field:'.length) {
    return { kind: 'field', name: ref.slice('field:'.length) }
  }
  // login.totp 不收：验证码的密钥不由 Kioku 写
  throw unsupportedField()
}

// 登录里的字段只给登录类；条目的类型不知道时（修改，取到条目之前）为 null，取到之后再查一次
export function checkType(values: WriteValue[], type: VaultItemType | null): void {
  if (type === null || type === 'login') return
  if (
    values.some((v) => v.target.kind === 'login.username' || v.target.kind === 'login.password')
  ) {
    throw unsupportedField()
  }
}

// 在入口解析一次要写的字段：写法不对时在发请求之前报错，不留下写了一半的条目
export function writeValues(
  values: Record<VaultFieldRef, string>,
  type: VaultItemType | null,
): WriteValue[] {
  const parsed = Object.entries(values).map(([ref, value]) => ({ target: writeTarget(ref), value }))
  checkType(parsed, type)
  return parsed
}

export function checkNewItem(item: VaultNewItem): WriteValue[] {
  const values = writeValues(item.values, item.type)
  if (item.type !== 'login' && item.uris?.length) throw unsupportedField()
  return values
}

// 服务端按密文的字符数限长，超了回 400。官方服务：名称、用户名、自定义字段名 1000，密码、自定义字段值、
// 密码历史 5000，备注、网址 10000；Vaultwarden 只限备注 10000（私钥、长的令牌写得进去）。
// 发请求之前按服务器的上限查：会话认出是 Vaultwarden 时用 VAULTWARDEN_LIMITS，官方服务与认不出的用 OFFICIAL_LIMITS
type Limited =
  'name' | 'username' | 'password' | 'notes' | 'fieldName' | 'fieldValue' | 'uri' | 'history'

export type LengthLimits = Partial<Record<Limited, number>>

export const OFFICIAL_LIMITS: LengthLimits = {
  name: 1000,
  username: 1000,
  password: 5000,
  notes: 10000,
  fieldName: 1000,
  fieldValue: 5000,
  uri: 10000,
  history: 5000,
}

export const VAULTWARDEN_LIMITS: LengthLimits = { notes: 10000 }

const LABELS: Record<Limited, string> = {
  name: '名称',
  username: '用户名',
  password: '密码',
  notes: '备注',
  fieldName: '自定义字段名',
  fieldValue: '自定义字段的值',
  uri: '网址',
  history: '密码历史',
}

// 加密并按上限查；超了返回 null
function encWithin(value: string, key: SymmetricKey, what: Limited, limits: LengthLimits) {
  const out = encryptText(value, key)
  const max = limits[what]
  return max !== undefined && out.length > max ? null : out
}

function encLimited(value: string, key: SymmetricKey, what: Limited, limits: LengthLimits): string {
  const out = encWithin(value, key, what, limits)
  if (out === null) throw new VaultError('value_too_long', `${LABELS[what]}超出密码库的长度上限`)
  return out
}

// 网址的校验和：网址的 SHA-256 写成 base64 再加密。官方客户端解开带条目密钥的条目时按它核对网址
function uriEntry(uri: string, autofill: boolean, key: SymmetricKey, limits: LengthLimits) {
  const checksum = createHash('sha256').update(uri, 'utf8').digest('base64')
  return {
    uri: encLimited(uri, key, 'uri', limits),
    uriChecksum: encLimited(checksum, key, 'uri', limits),
    match: autofill ? MATCH_HOST : MATCH_NEVER,
  }
}

// POST /ciphers/create 的请求体：放进组织与一个集合。encryptedFor 是写入的账号（Vaultwarden 要求，官方服务核对它）。
// values 是 checkNewItem 解析过的
export function newCipherBody(
  item: VaultNewItem,
  values: WriteValue[],
  orgKey: SymmetricKey,
  userId: string,
  limits: LengthLimits,
) {
  const enc = (value: string, what: Limited) => encLimited(value, orgKey, what, limits)
  let username: string | null = null
  let password: string | null = null
  let notes: string | null = null
  const fields: { type: number; name: string; value: string; linkedId: null }[] = []
  for (const { target, value } of values) {
    if (target.kind === 'login.username') username = enc(value, 'username')
    else if (target.kind === 'login.password') password = enc(value, 'password')
    else if (target.kind === 'notes') notes = enc(value, 'notes')
    else {
      fields.push({
        type: HIDDEN_FIELD,
        name: enc(target.name, 'fieldName'),
        value: enc(value, 'fieldValue'),
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
      name: enc(item.name, 'name'),
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
            uris: (item.uris ?? []).map((u) => uriEntry(u.uri, u.autofill, orgKey, limits)),
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

export interface UpdateInput {
  // GET /ciphers/{id} 的响应，已经由 decodeItem 解开核对过
  raw: unknown
  name: string | undefined
  // updateItem 入口解析过、按条目类型查过的
  values: WriteValue[]
  orgKey: SymmetricKey
  userId: string
  // 记进密码历史的时间
  now: string
  limits: LengthLimits
  // 隐藏字段的旧值记进历史会超长时不记这一条，修改照常；调用方记日志（不带值）
  onHistorySkipped: () => void
}

// PUT /ciphers/{id} 的请求体；什么都没变时为 null，不发请求（发了服务端照样改修改时间，别处正在改的会因此冲突）。
// 值和原来一样的字段不换密文。密码历史照官方客户端：改了登录密码时旧密码（原来的密文）记进去，改了隐藏字段时记
// 「名字: 旧值」，都插在最前面（先旧密码，再按字段在条目里的顺序逐个插），最多 5 条；旧值是空的不记，
// 「名字: 旧值」加密后超出上限的也不记（旧值接近上限的隐藏字段照样能改）。
// 附件不带：响应里的附件是数组，请求里是按 id 的对象，官方服务认不出数组；不带时服务端两边都不动附件
export function updatedCipherBody(input: UpdateInput): Json | null {
  const { orgKey, userId, now, limits } = input
  if (!isObject(input.raw)) throw unsupportedField()
  const body = structuredClone(input.raw)
  const itemKeyEnc = str(body, 'key')
  const key = itemKeyEnc ? splitKey(decryptBytes(itemKeyEnc, orgKey)) : orgKey
  const decrypt = (value: unknown) => (isEnc(value) ? decryptText(value, key) : null)
  const enc = (value: string, what: Limited) => encLimited(value, key, what, limits)
  let changed = false

  if (input.name !== undefined && decrypt(prop(body, 'name')) !== input.name) {
    setProp(body, 'name', enc(input.name, 'name'))
    changed = true
  }

  // 字段名在循环之前解开一次
  const named = namedFields(prop(body, 'fields'), key)
  let passwordEntry: Json | null = null
  const fieldEntries: { index: number; entry: Json }[] = []
  for (const { target, value } of input.values) {
    if (target.kind === 'notes') {
      if (decrypt(prop(body, 'notes')) === value) continue
      setProp(body, 'notes', enc(value, 'notes'))
    } else if (target.kind === 'login.username') {
      const login = childObject(body, 'login')
      if (decrypt(prop(login, 'username')) === value) continue
      setProp(login, 'username', enc(value, 'username'))
    } else if (target.kind === 'login.password') {
      const login = childObject(body, 'login')
      const old = prop(login, 'password')
      const oldPlain = decrypt(old)
      if (oldPlain === value) continue
      setProp(login, 'password', enc(value, 'password'))
      if (oldPlain) {
        passwordEntry = { password: old, lastUsedDate: now }
        setProp(login, 'passwordRevisionDate', now)
      }
    } else {
      const found = named.get(target.name)
      if (!found) {
        const field = {
          type: HIDDEN_FIELD,
          name: enc(target.name, 'fieldName'),
          value: enc(value, 'fieldValue'),
          linkedId: null,
        }
        childArray(body, 'fields').push(field)
      } else {
        const oldPlain = decrypt(prop(found.field, 'value'))
        if (oldPlain === value) continue
        setProp(found.field, 'value', enc(value, 'fieldValue'))
        if (Number(prop(found.field, 'type')) === HIDDEN_FIELD && oldPlain) {
          const entry = encWithin(`${target.name}: ${oldPlain}`, key, 'history', limits)
          if (entry === null) input.onHistorySkipped()
          else
            fieldEntries.push({ index: found.index, entry: { password: entry, lastUsedDate: now } })
        }
      }
    }
    changed = true
  }
  if (!changed) return null

  // 逐个插在最前面：条目里靠后的字段最后插，排在最前
  const added = [
    ...fieldEntries.sort((a, b) => b.index - a.index).map((f) => f.entry),
    ...(passwordEntry ? [passwordEntry] : []),
  ]
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
