import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'

import {
  decryptBytes,
  deriveMasterKey,
  encryptBytes,
  encryptRsa,
  encryptText,
  joinKey,
  masterPasswordHash,
  normalizeEmail,
  splitKey,
  stretchMasterKey,
  type KdfParams,
  type SymmetricKey,
} from '../credential/bitwarden/crypto'
import { totpCode } from '../credential/bitwarden/totp'

// 在一个空的 Vaultwarden 上造测试数据：成员本人与专用账号、组织与集合、几类条目。
// 加密用 credential/bitwarden/crypto.ts 的实现，所以测试要再用官方 bw 命令行反过来核对一遍。
// 只用于本地起的测试实例（docker-compose.dev.yml 的 vaultwarden），账号与密码都是随机生成的

export interface SeedAccount {
  email: string
  password: string
  kdf: KdfParams
  userId: string
  userKey: SymmetricKey
  publicKey: Buffer
  privateKey: Buffer
  accessToken: string
}

const PBKDF2: KdfParams = { kind: 'pbkdf2', iterations: 600_000 }
const ARGON2: KdfParams = { kind: 'argon2id', iterations: 3, memoryMiB: 64, parallelism: 4 }

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} 返回 ${res.status}：${text.slice(0, 300)}`)
  if (!text) return null
  // 没配 SMTP 时注册的第一步直接回邮箱验证令牌，不是 JSON
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const randomPassword = () => randomBytes(18).toString('base64url')

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return bits > 0 ? out + alphabet[(value << (5 - bits)) & 31] : out
}

// 两步注册：没配 SMTP 时 send-verification-email 直接在响应里给出邮箱验证令牌
export async function registerAccount(
  base: string,
  email: string,
  kdf: KdfParams,
  password = randomPassword(),
): Promise<SeedAccount> {
  const salt = normalizeEmail(email)
  const masterKey = await deriveMasterKey(password, salt, kdf)
  const hash = await masterPasswordHash(masterKey, password)
  const userKeyBytes = randomBytes(64)
  const userKey = splitKey(userKeyBytes)
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const token = await call(base, 'POST', '/identity/accounts/register/send-verification-email', {
    email,
    name: email.split('@')[0],
    receiveMarketingEmails: false,
  })
  await call(base, 'POST', '/identity/accounts/register/finish', {
    email,
    emailVerificationToken: token,
    masterPasswordHash: hash,
    masterPasswordHint: null,
    userSymmetricKey: encryptBytes(userKeyBytes, stretchMasterKey(masterKey)),
    userAsymmetricKeys: {
      publicKey: publicKey.toString('base64'),
      encryptedPrivateKey: encryptBytes(privateKey, userKey),
    },
    kdf: kdf.kind === 'pbkdf2' ? 0 : 1,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.kind === 'argon2id' ? kdf.memoryMiB : null,
    kdfParallelism: kdf.kind === 'argon2id' ? kdf.parallelism : null,
  })
  const account = {
    email,
    password,
    kdf,
    userKey,
    publicKey,
    privateKey,
    userId: '',
    accessToken: '',
  }
  await relogin(base, account)
  return account
}

// 用密码换一个访问令牌，造数据时用；被测的客户端另走自己的登录
export async function relogin(
  base: string,
  account: SeedAccount,
  twoFactorCode?: string,
): Promise<void> {
  const masterKey = await deriveMasterKey(
    account.password,
    normalizeEmail(account.email),
    account.kdf,
  )
  const res = await fetch(`${base}/identity/connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: account.email,
      password: await masterPasswordHash(masterKey, account.password),
      scope: 'api offline_access',
      client_id: 'web',
      deviceType: '9',
      deviceIdentifier: randomUUID(),
      deviceName: 'seed',
      ...(twoFactorCode
        ? { twoFactorToken: twoFactorCode, twoFactorProvider: '0', twoFactorRemember: '0' }
        : {}),
    }).toString(),
  })
  const json = (await res.json()) as { access_token?: string; Key?: string; key?: string }
  if (!res.ok || !json.access_token) throw new Error(`登录 ${account.email} 失败：${res.status}`)
  const userKey = decryptBytes(json.Key ?? json.key ?? '', stretchMasterKey(masterKey))
  if (!userKey.equals(joinKey(account.userKey))) throw new Error('账户密钥对不上')
  account.accessToken = json.access_token
  const payload = JSON.parse(
    Buffer.from(json.access_token.split('.')[1]!, 'base64url').toString('utf8'),
  ) as { sub: string }
  account.userId = payload.sub
}

export interface SeedOrg {
  id: string
  key: SymmetricKey
  collections: Record<string, string>
}

export async function createOrganization(
  base: string,
  owner: SeedAccount,
  name: string,
  collectionNames: string[],
): Promise<SeedOrg> {
  const keyBytes = randomBytes(64)
  const key = splitKey(keyBytes)
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const org = (await call(
    base,
    'POST',
    '/api/organizations',
    {
      name,
      billingEmail: owner.email,
      planType: 0,
      key: encryptRsa(keyBytes, owner.publicKey, 'sha1'),
      keys: {
        publicKey: publicKey.toString('base64'),
        encryptedPrivateKey: encryptBytes(privateKey, key),
      },
      collectionName: encryptText(collectionNames[0]!, key),
    },
    owner.accessToken,
  )) as { id: string }
  const collections: Record<string, string> = {}
  const existing = (await call(
    base,
    'GET',
    `/api/organizations/${org.id}/collections`,
    undefined,
    owner.accessToken,
  )) as { data: { id: string }[] }
  collections[collectionNames[0]!] = existing.data[0]!.id
  for (const colName of collectionNames.slice(1)) {
    const col = (await call(
      base,
      'POST',
      `/api/organizations/${org.id}/collections`,
      { name: encryptText(colName, key), groups: [], users: [] },
      owner.accessToken,
    )) as { id: string }
    collections[colName] = col.id
  }
  return { id: org.id, key, collections }
}

// 邀请已注册的账号并确认，只分配给定的集合。没配 SMTP 时已注册的账号受邀即为已接受
export async function addMember(
  base: string,
  owner: SeedAccount,
  org: SeedOrg,
  member: SeedAccount,
  type: number,
  collectionIds: string[],
  readOnly = true,
): Promise<void> {
  await call(
    base,
    'POST',
    `/api/organizations/${org.id}/users/invite`,
    {
      emails: [member.email],
      type,
      accessAll: false,
      groups: [],
      permissions: {},
      collections: collectionIds.map((id) => ({
        id,
        readOnly,
        hidePasswords: false,
        manage: false,
      })),
    },
    owner.accessToken,
  )
  const users = (await call(
    base,
    'GET',
    `/api/organizations/${org.id}/users`,
    undefined,
    owner.accessToken,
  )) as { data: { id: string; email: string; userId: string }[] }
  const orgUser = users.data.find((u) => u.email === member.email)
  if (!orgUser) throw new Error('受邀的成员不在组织里')
  const { publicKey } = (await call(
    base,
    'GET',
    `/api/users/${member.userId}/public-key`,
    undefined,
    owner.accessToken,
  )) as { publicKey: string }
  await call(
    base,
    'POST',
    `/api/organizations/${org.id}/users/${orgUser.id}/confirm`,
    { key: encryptRsa(joinKey(org.key), Buffer.from(publicKey, 'base64'), 'sha1') },
    owner.accessToken,
  )
}

export interface SeedLogin {
  name: string
  username?: string
  password?: string
  totp?: string
  notes?: string
  fields?: { name: string; value: string; type?: number }[]
  uri?: string
}

export interface SeedCipher {
  type: 'login' | 'note'
  login?: SeedLogin
  note?: { name: string; notes: string; fields?: { name: string; value: string }[] }
  // 条目自己的密钥：内容用它加密，它用组织密钥（或账户密钥）加密
  itemKey?: boolean
}

function cipherBody(
  c: SeedCipher,
  outer: SymmetricKey,
  organizationId: string | null,
  encryptedFor: string,
) {
  const itemKeyBytes = c.itemKey ? randomBytes(64) : null
  const key = itemKeyBytes ? splitKey(itemKeyBytes) : outer
  const enc = (v: string | undefined) => (v === undefined ? null : encryptText(v, key))
  const src = c.type === 'login' ? c.login! : c.note!
  const fields = (src.fields ?? []).map((f) => ({
    type: 'type' in f && f.type !== undefined ? f.type : 0,
    name: enc(f.name),
    value: enc(f.value),
    linkedId: null,
  }))
  return {
    type: c.type === 'login' ? 1 : 2,
    organizationId,
    encryptedFor,
    key: itemKeyBytes ? encryptBytes(itemKeyBytes, outer) : null,
    name: enc(src.name),
    notes: enc(c.type === 'login' ? c.login!.notes : c.note!.notes),
    favorite: false,
    reprompt: 0,
    fields,
    ...(c.type === 'login'
      ? {
          login: {
            username: enc(c.login!.username),
            password: enc(c.login!.password),
            totp: enc(c.login!.totp),
            uris: c.login!.uri ? [{ uri: enc(c.login!.uri), match: null }] : [],
          },
        }
      : { secureNote: { type: 0 } }),
  }
}

export async function createOrgCipher(
  base: string,
  account: SeedAccount,
  org: SeedOrg,
  collectionIds: string[],
  c: SeedCipher,
): Promise<string> {
  const res = (await call(
    base,
    'POST',
    '/api/ciphers/create',
    { cipher: cipherBody(c, org.key, org.id, account.userId), collectionIds },
    account.accessToken,
  )) as { id: string }
  return res.id
}

export async function createPersonalCipher(
  base: string,
  account: SeedAccount,
  c: SeedCipher,
): Promise<string> {
  const res = (await call(
    base,
    'POST',
    '/api/ciphers',
    cipherBody(c, account.userKey, null, account.userId),
    account.accessToken,
  )) as { id: string }
  return res.id
}

// 移进回收站（软删除）
export async function trashCipher(base: string, account: SeedAccount, id: string): Promise<void> {
  await call(base, 'PUT', `/api/ciphers/${id}/delete`, undefined, account.accessToken)
}

// 登录用的验证码取下一个时间窗：打开两步验证时用掉了当前窗的验证码，Vaultwarden 不收同一个窗口里用过的，允许前后各差一个窗口
export const nextTotp = (secret: string) => totpCode(secret, Date.now() + 30_000)

// 打开验证器应用的两步验证，返回 base32 密钥
export async function enableAuthenticator(base: string, account: SeedAccount): Promise<string> {
  const secret = base32(randomBytes(20))
  const masterKey = await deriveMasterKey(
    account.password,
    normalizeEmail(account.email),
    account.kdf,
  )
  await call(
    base,
    'POST',
    '/api/two-factor/authenticator',
    {
      key: secret,
      token: totpCode(secret, Date.now()),
      masterPasswordHash: await masterPasswordHash(masterKey, account.password),
    },
    account.accessToken,
  )
  return secret
}

export interface Seeded {
  base: string
  member: SeedAccount
  dedicated: SeedAccount
  twoFactor: SeedAccount & { totpSecret: string }
  org: SeedOrg
  // 专用账号读得到的集合
  agentCollection: string
  // 专用账号读不到的集合
  otherCollection: string
  items: {
    login: string
    note: string
    itemKey: string
    hidden: string
    trashed: string
    personal: string[]
  }
  values: {
    login: Record<string, string>
    note: Record<string, string>
    itemKey: Record<string, string>
  }
}

export const LOGIN_TOTP = 'otpauth://totp/Example:agent?secret=JBSWY3DPEHPK3PXP&issuer=Example'

// 造一整套：成员本人（Argon2id，组织所有者）、专用账号（PBKDF2，组织里的普通成员，只分到 Agent 集合，另有两个个人条目）、
// 开了验证器两步验证的第三个账号。邮箱带随机后缀，同一个实例上可以反复造
export async function seedVaultwarden(base: string): Promise<Seeded> {
  const tag = randomBytes(4).toString('hex')
  const member = await registerAccount(base, `member-${tag}@example.com`, ARGON2)
  const dedicated = await registerAccount(base, `agent-${tag}@example.com`, PBKDF2)
  const twoFactorAccount = await registerAccount(base, `mfa-${tag}@example.com`, PBKDF2)
  const totpSecret = await enableAuthenticator(base, twoFactorAccount)

  const org = await createOrganization(base, member, `Kioku ${tag}`, ['Agent', 'Private'])
  const agentCollection = org.collections.Agent!
  const otherCollection = org.collections.Private!
  await addMember(base, member, org, dedicated, 2, [agentCollection])

  const login = {
    name: 'file-server',
    username: 'agent',
    password: randomPassword(),
    totp: LOGIN_TOTP,
    notes: '备注：给 agent 用',
    fields: [
      { name: 'api token', value: randomPassword(), type: 1 },
      { name: 'region', value: 'cn-north' },
    ],
    uri: 'https://files.example.com',
  }
  const loginId = await createOrgCipher(base, member, org, [agentCollection], {
    type: 'login',
    login,
  })
  const note = {
    name: 'deploy notes',
    notes: '部署说明\n第二行',
    fields: [{ name: 'host', value: '127.0.0.1' }],
  }
  const noteId = await createOrgCipher(base, member, org, [agentCollection], { type: 'note', note })
  const itemKeyLogin = { name: 'with item key', username: 'keyed', password: randomPassword() }
  const itemKeyId = await createOrgCipher(base, member, org, [agentCollection], {
    type: 'login',
    login: itemKeyLogin,
    itemKey: true,
  })
  const hidden = await createOrgCipher(base, member, org, [otherCollection], {
    type: 'login',
    login: { name: 'not for agent', password: randomPassword() },
  })
  const trashed = await createOrgCipher(base, member, org, [agentCollection], {
    type: 'login',
    login: { name: 'trashed', password: randomPassword() },
  })
  await trashCipher(base, member, trashed)
  const personal = [
    await createPersonalCipher(base, dedicated, {
      type: 'login',
      login: { name: 'personal one', password: randomPassword() },
    }),
    await createPersonalCipher(base, dedicated, {
      type: 'note',
      note: { name: 'personal two', notes: 'x' },
    }),
  ]
  // 成员本人的个人条目，不影响专用账号
  await createPersonalCipher(base, member, {
    type: 'login',
    login: { name: 'member personal', password: randomPassword() },
  })

  return {
    base,
    member,
    dedicated,
    twoFactor: { ...twoFactorAccount, totpSecret },
    org,
    agentCollection,
    otherCollection,
    items: { login: loginId, note: noteId, itemKey: itemKeyId, hidden, trashed, personal },
    values: {
      login: {
        'login.username': login.username,
        'login.password': login.password,
        'login.totp': login.totp,
        notes: login.notes,
        'field:api token': login.fields[0]!.value,
        'field:region': login.fields[1]!.value,
      },
      note: { notes: note.notes, 'field:host': note.fields[0]!.value },
      itemKey: { 'login.username': itemKeyLogin.username, 'login.password': itemKeyLogin.password },
    },
  }
}
