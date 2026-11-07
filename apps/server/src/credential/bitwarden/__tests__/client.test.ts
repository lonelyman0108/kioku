import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { DrizzleQueryError } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { createVaultClient, type VaultClientOptions } from '../client'
import { decryptBytes, decryptText, encryptText, splitKey, type SymmetricKey } from '../crypto'
import { CLIENT_VERSION, vaultEndpoints } from '../http'
import {
  VaultError,
  type VaultLoginInput,
  type VaultNewItem,
  type VaultSecrets,
  type VaultSessionInput,
  type VaultSnapshot,
} from '../types'
import { decodeSync } from '../vault'
import type { RecordedExchange } from '../../../testing/recordVaultFixtures'

// 用本地 Vaultwarden 录下的响应（src/testing/recordVaultFixtures.ts 生成）回放。账号与密码都是测试数据

interface Fixture {
  server: string
  accounts: Record<
    'dedicated' | 'member' | 'twoFactor' | 'writer',
    { email: string; password: string; deviceId: string }
  >
  organizationId: string
  collections: { agent: string; other: string }
  items: {
    login: string
    note: string
    itemKey: string
    bw: string
    bwItemKey: string
    hidden: string
    trashed: string
    personal: string[]
    missing: string
    createdLogin: string
    createdNote: string
  }
  values: Record<'login' | 'note' | 'itemKey' | 'bw' | 'bwItemKey', Record<string, string>>
  writes: Record<'createLogin' | 'createNote' | 'update' | 'updateItemKey', Record<string, string>>
  exchanges: RecordedExchange[]
}

// 客户端默认把诊断打到 console.warn，这里静音；要核对日志的用例自己传 log
vi.spyOn(console, 'warn').mockImplementation(() => {})

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/vaultwarden.json', import.meta.url), 'utf8'),
) as Fixture
const server = fixture.server

interface Call {
  url: URL
  init: RequestInit
  form: Record<string, string> | null
}

type Override = (call: Call, recorded: RecordedExchange | undefined) => Response | undefined

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// 按场景回放：方法、路径与 grant_type 对得上的第一条。密码登录时核对发出的主密码哈希和录下的一样（验证 KDF）。
// 回放过一次录下的写入之后，取这个条目时用录下的、排在那次写入后面的那一条（写完再取的那份）
function replay(scenarios: string[], override?: Override) {
  const calls: Call[] = []
  const writtenAt = new Map<string, number>()
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const form = url.pathname.endsWith('/connect/token')
      ? Object.fromEntries(new URLSearchParams(String(init.body)))
      : null
    const call = { url, init, form }
    calls.push(call)
    const matches = (e: RecordedExchange) =>
      (scenarios.includes(e.scenario) || e.path === '/api/config') &&
      e.method === (init.method ?? 'GET') &&
      e.path === url.pathname &&
      (e.form?.grant_type ?? null) === (form?.grant_type ?? null)
    const after = writtenAt.get(url.pathname)
    const recorded =
      (after === undefined
        ? undefined
        : fixture.exchanges.find((e, i) => i > after && matches(e))) ??
      fixture.exchanges.find(matches)
    const replaced = override?.(call, recorded)
    if (replaced) return replaced
    if (!recorded) throw new Error(`没有录下的响应：${init.method} ${url.pathname}`)
    if (recorded.status === 200 && (init.method === 'PUT' || init.method === 'POST')) {
      const id = (recorded.body as { id?: unknown } | null)?.id
      if (typeof id === 'string')
        writtenAt.set(`/api/ciphers/${id}`, fixture.exchanges.indexOf(recorded))
    }
    if (form?.grant_type === 'password') expect(form.password).toBe(recorded.form?.password)
    return json(recorded.status, recorded.body)
  })
  return { fetch: fetchFn as unknown as typeof fetch, calls }
}

const loginInput = (name: keyof Fixture['accounts']): VaultLoginInput => ({
  serverUrl: server,
  email: fixture.accounts[name].email,
  masterPassword: fixture.accounts[name].password,
  deviceId: fixture.accounts[name].deviceId,
})

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof VaultError) return err.kind
    throw err
  }
  return 'ok'
}

async function errorOf(p: Promise<unknown>): Promise<VaultError> {
  try {
    await p
  } catch (err) {
    if (err instanceof VaultError) return err
    throw err
  }
  throw new Error('应当失败')
}

type Account = 'dedicated' | 'member' | 'writer'

async function loginSecrets(name: Account): Promise<VaultSecrets> {
  const { fetch } = replay([`${name}.login`])
  const result = await createVaultClient({ fetch }).login(loginInput(name))
  if (result.kind !== 'ok') throw new Error('登录失败')
  return result.secrets
}

// scenarios 换掉默认的「<账号>.session」：回放按顺序取第一条对得上的，要用别的场景里的同步时整个换掉
function sessionOf(
  name: Account,
  secrets: VaultSecrets,
  extra: Partial<VaultSessionInput> = {},
  options: VaultClientOptions & { override?: Override; scenarios?: string[] } = {},
) {
  const r = replay(options.scenarios ?? [`${name}.session`], options.override)
  const session = createVaultClient({ ...options, fetch: r.fetch }).session({
    serverUrl: server,
    deviceId: fixture.accounts[name].deviceId,
    secrets,
    ...extra,
  })
  return { session, calls: r.calls }
}

const tokenCalls = (calls: Call[]) => calls.filter((c) => c.form?.grant_type === 'refresh_token')

const dedicatedSecrets = await loginSecrets('dedicated')
const memberSecrets = await loginSecrets('member')
const writerSecrets = await loginSecrets('writer')

describe('登录', () => {
  it('PBKDF2：派生的主密码哈希和录下的一样，解开账户密钥', async () => {
    const { fetch, calls } = replay(['dedicated.login'])
    const result = await createVaultClient({ fetch }).login(loginInput('dedicated'))
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.account.email).toBe(fixture.accounts.dedicated.email)
    expect(result.secrets.userKey).toHaveLength(64)
    const form = calls.find((c) => c.form)!.form!
    expect(form).toMatchObject({
      grant_type: 'password',
      deviceName: 'Kioku',
      deviceIdentifier: fixture.accounts.dedicated.deviceId,
      scope: 'api offline_access',
    })
    // 返回值里没有主密码与主密码哈希
    const out = JSON.stringify(result)
    expect(out).not.toContain(fixture.accounts.dedicated.password)
    expect(out).not.toContain(form.password)
  })

  it('Argon2id', async () => {
    const { fetch } = replay(['member.login'])
    const result = await createVaultClient({ fetch }).login(loginInput('member'))
    expect(result.kind).toBe('ok')
  })

  it('邮箱按小写、去掉空白发出', async () => {
    const { fetch } = replay(['dedicated.login'])
    const input = loginInput('dedicated')
    const result = await createVaultClient({ fetch }).login({
      ...input,
      email: `  ${input.email.toUpperCase()} `,
    })
    expect(result.kind).toBe('ok')
  })

  it('要求两步验证时返回可用的方式；验证码不对报 two_factor_invalid；对了登录成功', async () => {
    const required = await createVaultClient({ fetch: replay(['twoFactor.required']).fetch }).login(
      loginInput('twoFactor'),
    )
    expect(required).toEqual({ kind: 'two_factor_required', providers: ['authenticator'] })

    const invalid = createVaultClient({ fetch: replay(['twoFactor.invalid']).fetch }).login({
      ...loginInput('twoFactor'),
      twoFactor: { provider: 'authenticator', code: '000000' },
    })
    expect(await kindOf(invalid)).toBe('two_factor_invalid')

    const r = replay(['twoFactor.ok'])
    const ok = await createVaultClient({ fetch: r.fetch }).login({
      ...loginInput('twoFactor'),
      twoFactor: { provider: 'authenticator', code: '123 456' },
    })
    expect(ok.kind).toBe('ok')
    expect(r.calls.find((c) => c.form)!.form).toMatchObject({
      twoFactorToken: '123456',
      twoFactorProvider: '0',
    })
  })

  it('只认验证器：有验证器时只返回它；只有别的方式（邮件等）或服务端给了原型上的键时报 unsupported_two_factor', async () => {
    const withProviders = (providers: string) =>
      replay(['dedicated.login'], (call) =>
        call.form
          ? json(
              400,
              `{"error":"invalid_grant","error_description":"Two factor required.","TwoFactorProviders2":${providers}}`,
            )
          : undefined,
      ).fetch
    const mixed = await createVaultClient({
      fetch: withProviders('{"1":null,"0":null,"3":null}'),
    }).login(loginInput('dedicated'))
    expect(mixed).toEqual({ kind: 'two_factor_required', providers: ['authenticator'] })
    for (const providers of [
      '{"1":null}',
      '{"3":null,"7":null}',
      '{"constructor":null,"__proto__":null,"toString":null}',
    ]) {
      const err = await errorOf(
        createVaultClient({ fetch: withProviders(providers) }).login(loginInput('dedicated')),
      )
      expect(err.kind).toBe('unsupported_two_factor')
      expect(err.message).toContain('验证器')
    }
  })

  it('主密码不对报 invalid_credentials', async () => {
    const { fetch } = replay(['badPassword'])
    const input = { ...loginInput('dedicated'), masterPassword: 'not-the-password' }
    // 录的时候用的就是这个错误的主密码
    expect(await kindOf(createVaultClient({ fetch }).login(input))).toBe('invalid_credentials')
  })

  it('官方服务的新设备验证报 unsupported_two_factor', async () => {
    const { fetch } = replay(['dedicated.login'], (call) =>
      call.form
        ? json(400, {
            error: 'invalid_grant',
            error_description: 'New device verification required',
          })
        : undefined,
    )
    const err = await errorOf(createVaultClient({ fetch }).login(loginInput('dedicated')))
    expect(err.kind).toBe('unsupported_two_factor')
    expect(err.message).toBe('官方服务要求验证新设备：给专用账号开启验证器应用的两步验证后再连接')
  })

  it('KDF 参数超出范围报 unsupported_format，不发登录请求', async () => {
    for (const prelogin of [
      { kdf: 0, kdfIterations: 2_000_001 },
      { kdf: 1, kdfIterations: 3, kdfMemory: 257, kdfParallelism: 4 },
      { kdf: 1, kdfIterations: 11, kdfMemory: 64, kdfParallelism: 4 },
      { kdf: 1, kdfIterations: 3, kdfMemory: 64, kdfParallelism: 17 },
    ]) {
      const { fetch, calls } = replay(['dedicated.login'], (call) =>
        call.url.pathname.endsWith('/prelogin') ? json(200, prelogin) : undefined,
      )
      const err = await errorOf(createVaultClient({ fetch }).login(loginInput('dedicated')))
      expect(err.kind).toBe('unsupported_format')
      expect(err.message).toContain('超出范围')
      expect(calls.some((c) => c.form)).toBe(false)
    }
  })

  it('http 只收本机回环地址与不带点的服务名，别的在发请求之前报错', async () => {
    const { fetch, calls } = replay(['dedicated.login'])
    for (const serverUrl of [
      'http://vault.example.com',
      'http://10.0.0.1:8080',
      'http://vault.bitwarden.com',
      'http://[fd00::1]:8080',
      'http://vaultwarden.',
      // 写成数字的主机名会被 URL 规范成 IPv4 地址，按写下的判断，和契约一致
      'http://3232235777',
      'http://2130706433',
      'http://0x7f000001',
      'http://127.1',
    ]) {
      expect(
        await kindOf(createVaultClient({ fetch }).login({ ...loginInput('dedicated'), serverUrl })),
      ).toBe('unreachable')
      expect(() =>
        createVaultClient({ fetch }).session({
          serverUrl,
          deviceId: fixture.accounts.dedicated.deviceId,
          secrets: dedicatedSecrets,
        }),
      ).toThrow(
        '服务器地址须使用 https；本机地址与同一个 Docker 网络里的服务名（不带点的主机名）可以用 http',
      )
    }
    expect(calls).toHaveLength(0)
    for (const host of [
      'http://localhost:8080',
      'http://127.0.0.1',
      'http://[::1]:18081',
      'http://vaultwarden',
      'http://vault-server:8080',
    ]) {
      expect(vaultEndpoints(host).api).toBe(`${host}/api`)
    }
  })

  it('账户密钥的 MAC 被改过时报 integrity', async () => {
    const { fetch } = replay(['dedicated.login'], (call, recorded) => {
      if (!call.form || !recorded) return undefined
      const body = structuredClone(recorded.body) as { Key: string }
      body.Key = tamperMac(body.Key)
      return json(200, body)
    })
    expect(await kindOf(createVaultClient({ fetch }).login(loginInput('dedicated')))).toBe(
      'integrity',
    )
  })
})

// 改 EncString 里 MAC 的一个字符
function tamperMac(enc: string): string {
  const at = enc.lastIndexOf('|') + 3
  return enc.slice(0, at) + (enc[at] === 'A' ? 'B' : 'A') + enc.slice(at + 1)
}

function syncBody(name: Account) {
  return structuredClone(
    fixture.exchanges.find((e) => e.scenario === `${name}.session` && e.path === '/api/sync')!.body,
  ) as {
    profile: {
      privateKey: string
      organizations: {
        id: string
        key: string
        type: unknown
        accessAll?: boolean
        permissions: Record<string, boolean>
      }[]
    }
    collections: { name: string }[]
    ciphers: {
      id: string
      name: string
      type: unknown
      revisionDate?: string
      organizationId: string | null
      deletedDate: string | null
    }[]
  }
}

describe('同步', () => {
  it('专用账号：组织角色、只分到的集合、个人条目只计数、回收站里的不算', async () => {
    const { session } = sessionOf('dedicated', dedicatedSecrets)
    const snapshot = await session.snapshot()
    expect(snapshot.account.email).toBe(fixture.accounts.dedicated.email)
    expect(snapshot.organizations).toEqual([
      expect.objectContaining({ id: fixture.organizationId, role: 'user', allCollections: false }),
    ])
    expect(snapshot.unreadableItemCount).toBe(0)
    expect(snapshot.collections).toEqual([
      {
        id: fixture.collections.agent,
        organizationId: fixture.organizationId,
        name: 'Agent',
        readOnly: true,
      },
    ])
    expect(snapshot.personalItemCount).toBe(2)
    const byId = new Map(snapshot.items.map((i) => [i.id, i]))
    const { items } = fixture
    expect([...byId.keys()].sort()).toEqual(
      [items.login, items.note, items.itemKey, items.bw, items.bwItemKey].sort(),
    )
    expect(byId.get(items.login)).toMatchObject({
      name: 'file-server',
      type: 'login',
      collectionIds: [fixture.collections.agent],
      fields: [
        'login.username',
        'login.password',
        'login.totp',
        'notes',
        'field:api token',
        'field:region',
      ],
    })
    expect(byId.get(items.note)).toMatchObject({
      name: 'deploy notes',
      type: 'note',
      fields: ['notes', 'field:host'],
    })
    expect(byId.get(items.bwItemKey)?.name).toBe('bw bwItemKey')
    // 概况里没有值
    const text = JSON.stringify(snapshot)
    for (const values of Object.values(fixture.values)) {
      for (const [ref, value] of Object.entries(values)) {
        if (ref !== 'notes' && value.length > 8) expect(text).not.toContain(value)
      }
    }
  })

  it('成员本人：所有者，看得到全部集合', async () => {
    const { session } = sessionOf('member', memberSecrets)
    const snapshot = await session.snapshot()
    expect(snapshot.organizations[0]).toMatchObject({ role: 'owner', allCollections: true })
    expect(snapshot.collections.map((c) => c.name).sort()).toEqual(['Agent', 'Private'])
    expect(snapshot.personalItemCount).toBe(1)
    expect(snapshot.items.map((i) => i.id)).toContain(fixture.items.hidden)
    expect(snapshot.items.map((i) => i.id)).not.toContain(fixture.items.trashed)
  })

  const withSync = (body: unknown) => ({
    override: (call: Call) => (call.url.pathname === '/api/sync' ? json(200, body) : undefined),
  })

  it('不认识的组织角色（包括原型上的名字）不当作普通成员', async () => {
    for (const type of [9, '2', 'constructor', '__proto__']) {
      const body = syncBody('dedicated')
      body.profile.organizations[0]!.type = type
      const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
      expect(await kindOf(session.snapshot())).toBe('server_error')
    }
  })

  it('普通成员开了访问全部集合，或者能编辑、删除任何集合时算看得到全部集合', async () => {
    const mutations: ((org: ReturnType<typeof syncBody>['profile']['organizations'][0]) => void)[] =
      [
        (org) => (org.accessAll = true),
        (org) => (org.permissions.editAnyCollection = true),
        (org) => (org.permissions.deleteAnyCollection = true),
        (org) => (org.permissions.accessImportExport = true),
        (org) => (org.permissions.manageGroups = true),
        (org) => (org.permissions.manageUsers = true),
        (org) => (org.type = 1),
      ]
    for (const mutate of mutations) {
      const body = syncBody('dedicated')
      mutate(body.profile.organizations[0]!)
      const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
      expect((await session.snapshot()).organizations[0]?.allCollections).toBe(true)
    }
  })

  it('一个条目解不开（MAC 不对、不认识的格式、缺字段、不认识的类型）只跳过它，计进 unreadableItemCount', async () => {
    const login = (b: ReturnType<typeof syncBody>) =>
      b.ciphers.find((x) => x.id === fixture.items.login)!
    const cases: ((b: ReturnType<typeof syncBody>) => void)[] = [
      (b) => (login(b).name = tamperMac(login(b).name)),
      (b) => (login(b).name = `0.${login(b).name.slice(2).split('|').slice(0, 2).join('|')}`),
      (b) => (login(b).name = `1.${login(b).name.slice(2)}`),
      (b) => (login(b).name = `7.${login(b).name.slice(2)}`),
      (b) => delete login(b).revisionDate,
      (b) => (login(b).type = 99),
      (b) => (login(b).type = 'constructor'),
      (b) => (login(b).type = '__proto__'),
      (b) => (login(b).type = '1.0'),
    ]
    for (const mutate of cases) {
      const body = syncBody('dedicated')
      mutate(body)
      const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
      const snapshot = await session.snapshot()
      expect(snapshot.unreadableItemCount).toBe(1)
      expect(snapshot.items.map((i) => i.id)).not.toContain(fixture.items.login)
      expect(snapshot.items).toHaveLength(4)
    }
  })

  it('集合解不开时不列，条目照常', async () => {
    const body = syncBody('dedicated')
    body.collections[0]!.name = `8.${body.collections[0]!.name.slice(2)}`
    const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
    const snapshot = await session.snapshot()
    expect(snapshot.collections).toEqual([])
    expect(snapshot.items).toHaveLength(5)
  })

  it('条目类型写成整数形式的字符串也认', async () => {
    const body = syncBody('dedicated')
    for (const c of body.ciphers) c.type = String(c.type)
    const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
    const snapshot = await session.snapshot()
    expect(snapshot.unreadableItemCount).toBe(0)
    expect(snapshot.items.find((i) => i.id === fixture.items.login)?.type).toBe('login')
  })

  it('组织有密钥、profile 没有私钥：条目都算解不开，取条目报 unsupported_format，不反复重新同步', async () => {
    const body = syncBody('dedicated')
    delete (body.profile as { privateKey?: string }).privateKey
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
    const snapshot = await session.snapshot()
    expect(snapshot.items).toEqual([])
    expect(snapshot.unreadableItemCount).toBe(5)
    for (let i = 0; i < 3; i++) {
      expect(await kindOf(session.item(fixture.items.login))).toBe('unsupported_format')
    }
    expect(calls.filter((c) => c.url.pathname === '/api/sync')).toHaveLength(1)
  })

  it('响应格式不对时内部日志记下接口与缺的字段，不带正文', async () => {
    const body = syncBody('dedicated') as unknown as { profile: Record<string, unknown> }
    delete body.profile.email
    const log = vi.fn()
    const { session } = sessionOf('dedicated', dedicatedSecrets, {}, { ...withSync(body), log })
    const err = await errorOf(session.snapshot())
    expect(err.kind).toBe('server_error')
    expect(err.message).toBe('密码库返回了意外的响应')
    expect(log).toHaveBeenCalledWith({ what: 'format', endpoint: 'sync', problem: 'missing email' })

    const prelogin = vi.fn()
    const { fetch } = replay(['dedicated.login'], (call) =>
      call.url.pathname.endsWith('/prelogin') ? json(200, { salt: 'RESPONSE-BODY' }) : undefined,
    )
    await errorOf(createVaultClient({ fetch, log: prelogin }).login(loginInput('dedicated')))
    expect(prelogin).toHaveBeenCalledWith({
      what: 'format',
      endpoint: 'prelogin',
      problem: 'missing kdf',
    })
    expect(JSON.stringify(prelogin.mock.calls)).not.toContain('RESPONSE-BODY')
  })

  it('组织密钥解不开时这个组织的条目都算解不开，取其中的条目报同样的错误', async () => {
    const cases: [(b: ReturnType<typeof syncBody>) => void, string][] = [
      [
        (b) =>
          (b.profile.organizations[0]!.key = `6.${b.profile.organizations[0]!.key.slice(2)}|AAAA`),
        'unsupported_format',
      ],
      [(b) => (b.profile.privateKey = tamperMac(b.profile.privateKey)), 'integrity'],
    ]
    for (const [mutate, kind] of cases) {
      const body = syncBody('dedicated')
      mutate(body)
      const { session } = sessionOf('dedicated', dedicatedSecrets, {}, withSync(body))
      const snapshot = await session.snapshot()
      expect(snapshot.items).toEqual([])
      expect(snapshot.unreadableItemCount).toBe(5)
      expect(snapshot.organizations).toHaveLength(1)
      expect(snapshot.personalItemCount).toBe(2)
      expect(await kindOf(session.item(fixture.items.login))).toBe(kind)
    }
  })
})

describe('取条目', () => {
  it('解开全部值，包括条目自己的密钥与 bw 写的条目', async () => {
    const { session } = sessionOf('dedicated', dedicatedSecrets)
    for (const name of ['login', 'note', 'itemKey', 'bw', 'bwItemKey'] as const) {
      const item = await session.item(fixture.items[name])
      expect(item.values).toEqual(fixture.values[name])
      expect(item.organizationId).toBe(fixture.organizationId)
      // Vaultwarden 的单个条目不带集合，取同步时的
      expect(item.collectionIds).toEqual([fixture.collections.agent])
    }
  })

  it('读不到的、回收站里的、个人条目、不存在的与不像 id 的都报 item_unavailable', async () => {
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets)
    const { items } = fixture
    for (const id of [items.hidden, items.trashed, ...items.personal, items.missing]) {
      expect(await kindOf(session.item(id))).toBe('item_unavailable')
    }
    const before = calls.length
    expect(await kindOf(session.item('../sync'))).toBe('item_unavailable')
    expect(calls.length).toBe(before)
  })

  it('条目里的值的 MAC 被改过时报 integrity', async () => {
    const recorded = fixture.exchanges.find(
      (e) => e.scenario === 'dedicated.session' && e.path === `/api/ciphers/${fixture.items.login}`,
    )!
    const body = structuredClone(recorded.body) as { login: { password: string } }
    body.login.password = tamperMac(body.login.password)
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        override: (call) => (call.url.pathname === recorded.path ? json(200, body) : undefined),
      },
    )
    expect(await kindOf(session.item(fixture.items.login))).toBe('integrity')
  })

  it('条目是不认识的格式时报 unsupported_format', async () => {
    const recorded = fixture.exchanges.find(
      (e) => e.scenario === 'dedicated.session' && e.path === `/api/ciphers/${fixture.items.login}`,
    )!
    for (const mutate of [
      (b: { name: string; type: unknown }) => (b.name = `1.${b.name.slice(2)}`),
      (b: { name: string; type: unknown }) => (b.type = 'constructor'),
    ]) {
      const body = structuredClone(recorded.body) as { name: string; type: unknown }
      mutate(body)
      const { session } = sessionOf(
        'dedicated',
        dedicatedSecrets,
        {},
        { override: (call) => (call.url.pathname === recorded.path ? json(200, body) : undefined) },
      )
      expect(await kindOf(session.item(fixture.items.login))).toBe('unsupported_format')
    }
  })

  it('没见过的组织：刚换令牌时不再同步第二次；之后的调用重新同步一次，遇到 401 时换令牌再试', async () => {
    const withoutOrg = syncBody('dedicated')
    withoutOrg.profile.organizations = []
    let syncs = 0
    const onSynced = vi.fn<(snapshot: VaultSnapshot) => Promise<void>>(async () => {})
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSynced },
      {
        override: (call) => {
          if (call.url.pathname !== '/api/sync') return undefined
          syncs++
          if (syncs === 1) return json(200, withoutOrg)
          if (syncs === 2) return json(401, {})
          return undefined
        },
      },
    )
    // 这次调用刚换令牌、同步过，组织不在里面：按不可用处理，不同步第二次
    expect(await kindOf(session.item(fixture.items.login))).toBe('item_unavailable')
    expect(syncs).toBe(1)
    // 下一次调用的令牌是旧的：为没见过的组织重新同步，遇到 401 换令牌再试
    expect((await session.item(fixture.items.login)).values).toEqual(fixture.values.login)
    expect(tokenCalls(calls)).toHaveLength(2)
    expect(syncs).toBe(3)
    // 第一次换令牌后的同步（没有组织）与第二次换令牌后的同步都交给了 onSynced
    expect(onSynced).toHaveBeenCalledTimes(2)
    expect(onSynced.mock.calls[0]![0].organizations).toEqual([])
    expect(onSynced.mock.calls[1]![0].organizations).toHaveLength(1)
  })

  it('为没见过的组织重新同步时 onSynced 抛错，取值失败', async () => {
    const withoutOrg = syncBody('dedicated')
    withoutOrg.profile.organizations = []
    let syncs = 0
    const refusal = new Error('角色不对')
    const onSynced = vi.fn(async () => {
      if (onSynced.mock.calls.length === 2) throw refusal
    })
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSynced },
      {
        override: (call) => {
          if (call.url.pathname !== '/api/sync') return undefined
          syncs++
          return syncs === 1 ? json(200, withoutOrg) : undefined
        },
      },
    )
    expect(await kindOf(session.item(fixture.items.login))).toBe('item_unavailable')
    await expect(session.item(fixture.items.login)).rejects.toBe(refusal)
    expect(syncs).toBe(2)
  })
})

describe('取全部条目', () => {
  const syncCalls = (calls: Call[]) => calls.filter((c) => c.url.pathname === '/api/sync')

  it('一次同步解开全部读得到的条目，和逐个取的值一样；交给 onSynced；刚换令牌时不再同步第二次', async () => {
    const onSynced = vi.fn<(snapshot: VaultSnapshot) => Promise<void>>(async () => {})
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets, { onSynced })
    const items = await session.items()
    expect(syncCalls(calls)).toHaveLength(1)
    expect(calls.some((c) => c.url.pathname.startsWith('/api/ciphers/'))).toBe(false)
    expect(onSynced).toHaveBeenCalledTimes(1)
    const byId = new Map(items.map((i) => [i.id, i]))
    const { items: ids } = fixture
    expect([...byId.keys()].sort()).toEqual(
      [ids.login, ids.note, ids.itemKey, ids.bw, ids.bwItemKey].sort(),
    )
    for (const name of ['login', 'note', 'itemKey', 'bw', 'bwItemKey'] as const) {
      expect(byId.get(ids[name])!.values).toEqual(fixture.values[name])
      expect(byId.get(ids[name])!.collectionIds).toEqual([fixture.collections.agent])
    }
    // 令牌还有效：再取时同步一次，同样交给 onSynced
    await session.items()
    expect(syncCalls(calls)).toHaveLength(2)
    expect(onSynced).toHaveBeenCalledTimes(2)
  })

  it('同时发起的 snapshot() 与 items() 共用一次换令牌与同步；原始响应不留在会话上', async () => {
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets)
    const [, items] = await Promise.all([
      session.snapshot(),
      session.items(),
      session.item(fixture.items.login),
    ])
    expect(items).toHaveLength(5)
    expect(syncCalls(calls)).toHaveLength(1)
    // 会话里只有令牌与同步的结果，没有哪里还引用着那份原始响应
    const access = (session as unknown as { access: Record<string, unknown> }).access
    expect(Object.keys(access).sort()).toEqual(['expiresAt', 'state', 'token'])
    expect(Object.keys(session).filter((k) => /raw/i.test(k))).toEqual([])
  })

  it('解不开的条目跳过，别的照常', async () => {
    const body = syncBody('dedicated')
    const login = body.ciphers.find((x) => x.id === fixture.items.login)!
    login.name = tamperMac(login.name)
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      { override: (call) => (call.url.pathname === '/api/sync' ? json(200, body) : undefined) },
    )
    const items = await session.items()
    expect(items.map((i) => i.id)).not.toContain(fixture.items.login)
    expect(items).toHaveLength(4)
  })

  it('onSynced 抛错时以同样的错误失败，不给值', async () => {
    const { session } = sessionOf('dedicated', dedicatedSecrets, {
      onSynced: async () => {
        throw new VaultError('server_error', '拒绝')
      },
    })
    expect(await kindOf(session.items())).toBe('server_error')
  })
})

describe('会话', () => {
  it('同时发起的调用只换一次令牌、同步一次，onSynced 调用一次', async () => {
    const onSynced = vi.fn<(snapshot: VaultSnapshot) => Promise<void>>(async () => {})
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets, { onSynced })
    await Promise.all([
      session.item(fixture.items.login),
      session.item(fixture.items.note),
      session.snapshot(),
    ])
    expect(tokenCalls(calls)).toHaveLength(1)
    expect(calls.filter((c) => c.url.pathname === '/api/sync')).toHaveLength(1)
    expect(onSynced).toHaveBeenCalledTimes(1)
    expect(onSynced.mock.calls[0]![0].personalItemCount).toBe(2)
    // 令牌没过期：再取不换令牌；列出条目时重新同步，同步的结果也交给 onSynced
    await session.item(fixture.items.itemKey)
    await session.snapshot()
    expect(tokenCalls(calls)).toHaveLength(1)
    expect(calls.filter((c) => c.url.pathname === '/api/sync')).toHaveLength(2)
    expect(onSynced).toHaveBeenCalledTimes(2)
  })

  it('访问令牌过期后换新的，再同步一次', async () => {
    let now = 1_000_000
    const onSynced = vi.fn(async () => {})
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSynced },
      { now: () => now },
    )
    await session.item(fixture.items.login)
    now += 3 * 60 * 60 * 1000
    await session.item(fixture.items.login)
    expect(tokenCalls(calls)).toHaveLength(2)
    expect(onSynced).toHaveBeenCalledTimes(2)
  })

  it('服务端拒绝访问令牌（401）时换一次令牌再试', async () => {
    let rejected = false
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        override: (call) => {
          if (call.url.pathname.startsWith('/api/ciphers/') && !rejected) {
            rejected = true
            return json(401, {})
          }
          return undefined
        },
      },
    )
    expect((await session.item(fixture.items.note)).values).toEqual(fixture.values.note)
    expect(tokenCalls(calls)).toHaveLength(2)
  })

  it('服务端给了新的刷新令牌时调用 onSecretsChanged，之后用新的换', async () => {
    let now = 1_000_000
    const onSecretsChanged = vi.fn<(secrets: VaultSecrets) => Promise<void>>(async () => {})
    let rotations = 0
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSecretsChanged },
      {
        now: () => now,
        override: (call, recorded) => {
          if (call.form?.grant_type !== 'refresh_token' || !recorded) return undefined
          rotations++
          return json(200, { ...(recorded.body as object), refresh_token: `rotated-${rotations}` })
        },
      },
    )
    await session.snapshot()
    expect(onSecretsChanged).toHaveBeenCalledTimes(1)
    const secrets = onSecretsChanged.mock.calls[0]![0]
    expect(secrets.refreshToken).toBe('rotated-1')
    expect(secrets.userKey.equals(dedicatedSecrets.userKey)).toBe(true)
    now += 3 * 60 * 60 * 1000
    await session.snapshot()
    expect(tokenCalls(calls)[1]!.form!.refresh_token).toBe('rotated-1')
    expect(onSecretsChanged).toHaveBeenCalledTimes(2)
  })

  it('刷新令牌没变时不调用 onSecretsChanged', async () => {
    const onSecretsChanged = vi.fn(async () => {})
    const { session } = sessionOf('dedicated', dedicatedSecrets, { onSecretsChanged })
    await session.snapshot()
    expect(onSecretsChanged).not.toHaveBeenCalled()
  })

  it('刷新令牌失效时报 reauth_required', async () => {
    const r = replay(['badRefresh'])
    const session = createVaultClient({ fetch: r.fetch }).session({
      serverUrl: server,
      deviceId: fixture.accounts.dedicated.deviceId,
      secrets: { refreshToken: 'revoked', userKey: dedicatedSecrets.userKey },
    })
    expect(await kindOf(session.snapshot())).toBe('reauth_required')
    expect(await kindOf(session.item(fixture.items.login))).toBe('reauth_required')
  })

  it('onSynced 抛错时这次调用以同样的错误失败，下一次重新换令牌并再检查', async () => {
    const refusal = new Error('有个人条目')
    const onSynced = vi.fn(async () => {
      if (onSynced.mock.calls.length === 1) throw refusal
    })
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets, { onSynced })
    await expect(session.item(fixture.items.login)).rejects.toBe(refusal)
    expect((await session.item(fixture.items.login)).values).toEqual(fixture.values.login)
    expect(onSynced).toHaveBeenCalledTimes(2)
    expect(tokenCalls(calls)).toHaveLength(2)
  })

  it('snapshot() 的同步被 onSynced 拒绝时，丢掉令牌，下一次取值重新换令牌并检查', async () => {
    const refusal = new Error('出现了个人条目')
    const onSynced = vi.fn(async () => {
      if (onSynced.mock.calls.length === 2) throw refusal
    })
    const { session, calls } = sessionOf('dedicated', dedicatedSecrets, { onSynced })
    await session.item(fixture.items.login)
    await expect(session.snapshot()).rejects.toBe(refusal)
    await session.item(fixture.items.login)
    expect(tokenCalls(calls)).toHaveLength(2)
    expect(onSynced).toHaveBeenCalledTimes(3)
  })

  it('onSecretsChanged 抛错不影响调用：会话接着用新的，记下原因，下一次调用开始时再保存', async () => {
    let now = 1_000_000
    // 服务端每次都给同一个新令牌
    const failure = Object.assign(
      new Error('insert into vault_connections values ($1) params: secret'),
      {
        code: '57P01',
      },
    )
    const onSecretsChanged = vi.fn<(secrets: VaultSecrets) => Promise<void>>(async () => {
      if (onSecretsChanged.mock.calls.length <= 2) throw failure
    })
    const log = vi.fn()
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSecretsChanged },
      {
        now: () => now,
        log,
        override: (call, recorded) => {
          if (call.form?.grant_type !== 'refresh_token' || !recorded) return undefined
          return json(200, { ...(recorded.body as object), refresh_token: 'rotated' })
        },
      },
    )
    expect((await session.snapshot()).items).toHaveLength(5)
    // 日志带上原因（经 loggableError 处理过的错误）
    expect(log).toHaveBeenCalledWith({ what: 'secrets_not_saved', error: failure })
    // 令牌还没过期：snapshot() 与 item() 开始时都再保存一次，不用等换令牌（第二次仍失败，第三次成功）
    await session.snapshot()
    expect(onSecretsChanged).toHaveBeenCalledTimes(2)
    await session.item(fixture.items.login)
    expect(tokenCalls(calls)).toHaveLength(1)
    expect(onSecretsChanged).toHaveBeenCalledTimes(3)
    expect(onSecretsChanged.mock.calls[2]![0].refreshToken).toBe('rotated')
    // 保存成功之后，同一个令牌不再交给它，换令牌时用的是新的
    await session.snapshot()
    now += 3 * 60 * 60 * 1000
    await session.snapshot()
    expect(tokenCalls(calls)[1]!.form!.refresh_token).toBe('rotated')
    expect(onSecretsChanged).toHaveBeenCalledTimes(3)
  })

  it('保存失败的原因是数据库错误时，日志里不带 SQL 与参数', async () => {
    const cause = Object.assign(new Error('terminating connection'), { code: '57P01' })
    const failure = new DrizzleQueryError(
      'update vault_connections set token = $1',
      ['rotated'],
      cause,
    )
    const log = vi.fn()
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {
        onSecretsChanged: async () => {
          throw failure
        },
      },
      {
        log,
        override: (call, recorded) => {
          if (call.form?.grant_type !== 'refresh_token' || !recorded) return undefined
          return json(200, { ...(recorded.body as object), refresh_token: 'rotated' })
        },
      },
    )
    await session.snapshot()
    const entry = log.mock.calls.find((c) => c[0].what === 'secrets_not_saved')![0]
    expect(entry.error).toMatchObject({ code: '57P01' })
    expect(JSON.stringify(entry)).not.toContain('update vault_connections')
    expect(JSON.stringify(entry)).not.toContain('rotated')
  })

  it('同时来的几次调用只保存一次', async () => {
    let release = () => {}
    const onSecretsChanged = vi.fn<(secrets: VaultSecrets) => Promise<void>>(async () => {
      if (onSecretsChanged.mock.calls.length === 1) throw new Error('第一次失败')
      await new Promise<void>((resolve) => (release = resolve))
    })
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSecretsChanged },
      {
        override: (call, recorded) => {
          if (call.form?.grant_type !== 'refresh_token' || !recorded) return undefined
          return json(200, { ...(recorded.body as object), refresh_token: 'rotated' })
        },
      },
    )
    await session.snapshot()
    const both = Promise.all([session.snapshot(), session.item(fixture.items.note)])
    await new Promise((resolve) => setTimeout(resolve, 10))
    release()
    await both
    expect(onSecretsChanged).toHaveBeenCalledTimes(2)
  })
})

describe('网络', () => {
  it('每个请求都不跟随重定向；3xx 报 server_error', async () => {
    const log = vi.fn()
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        log,
        override: (call) =>
          call.url.pathname === '/api/sync'
            ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
            : undefined,
      },
    )
    const err = await errorOf(session.snapshot())
    expect(err.kind).toBe('server_error')
    expect(err.message).toBe('密码库返回了意外的响应')
    expect(log).toHaveBeenCalledWith({ what: 'redirect', status: 302 })
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) expect(call.init.redirect).toBe('manual')
  })

  it('超时报 unreachable：响应头不来，或者正文不来', async () => {
    const hang = vi.fn(
      (_: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        }),
    )
    const client = createVaultClient({ fetch: hang as unknown as typeof fetch, timeoutMs: 50 })
    expect(await kindOf(client.login(loginInput('dedicated')))).toBe('unreachable')

    const stall = vi.fn(
      async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
    )
    const slow = createVaultClient({ fetch: stall as unknown as typeof fetch, timeoutMs: 50 })
    expect(await kindOf(slow.login(loginInput('dedicated')))).toBe('unreachable')
  })

  it('连不上时错误文字只写类别，错误代码进内部日志', async () => {
    const refuse = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed: Authorization Bearer leaked-token'), {
        cause: { code: 'ECONNREFUSED' },
      })
    })
    const log = vi.fn()
    const err = await errorOf(
      createVaultClient({ fetch: refuse as unknown as typeof fetch, log }).login(
        loginInput('dedicated'),
      ),
    )
    expect(err.kind).toBe('unreachable')
    expect(err.message).toBe('无法连接密码库')
    // 错误代码只进内部日志
    expect(log).toHaveBeenCalledWith({ what: 'connect', code: 'ECONNREFUSED' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('leaked-token')
    expect(err.cause).toBeUndefined()
  })

  it('意外的状态码与不是 JSON 的响应报 server_error', async () => {
    for (const res of [json(500, { message: 'boom' }), new Response('<html>', { status: 200 })]) {
      const log = vi.fn()
      const { fetch } = replay(['dedicated.login'], () => res.clone())
      const err = await errorOf(createVaultClient({ fetch, log }).login(loginInput('dedicated')))
      expect(err.kind).toBe('server_error')
      expect(err.message).toBe('密码库返回了意外的响应')
      if (res.status === 500) expect(log).toHaveBeenCalledWith({ what: 'status', status: 500 })
    }
  })

  it('官方服务的网页版地址换成它的接口与身份服务地址', () => {
    expect(vaultEndpoints('https://vault.bitwarden.com')).toEqual({
      api: 'https://api.bitwarden.com',
      identity: 'https://identity.bitwarden.com',
    })
    expect(vaultEndpoints('https://vault.example.com/sub/')).toEqual({
      api: 'https://vault.example.com/sub/api',
      identity: 'https://vault.example.com/sub/identity',
    })
    expect(() => vaultEndpoints('file:///etc/passwd')).toThrow(VaultError)
    expect(() => vaultEndpoints('https://user:pass@vault.example.com')).toThrow(VaultError)
    // 主机名是原型上的名字时不当作官方服务
    expect(vaultEndpoints('https://constructor').api).toBe('https://constructor/api')
    expect(vaultEndpoints('https://__proto__.example.com').api).toBe(
      'https://__proto__.example.com/api',
    )
  })
})

describe('错误信息', () => {
  it('不带主密码、令牌、响应正文、状态码与错误代码；内部日志也不带正文', async () => {
    const log = vi.fn()
    const marker = 'RESPONSE-BODY-MARKER'
    const refreshToken = fixture.exchanges.find((e) => e.form?.grant_type === 'refresh_token')!
      .form!.refresh_token!
    const accessToken = (
      fixture.exchanges.find((e) => e.form?.grant_type === 'refresh_token')!.body as {
        access_token: string
      }
    ).access_token
    const errors: unknown[] = []
    const collect = (p: Promise<unknown>) => p.catch((e: unknown) => errors.push(e))
    const bodies = [
      json(500, { message: marker, error_description: marker }),
      json(400, { error: marker, message: marker }),
      new Response(`${marker} not json`, { status: 200 }),
      json(418, marker),
    ]
    for (const body of bodies) {
      await collect(
        createVaultClient({
          fetch: replay(['dedicated.login'], () => body.clone()).fetch,
          log,
        }).login(loginInput('dedicated')),
      )
      const { session } = sessionOf(
        'dedicated',
        dedicatedSecrets,
        {},
        {
          log,
          override: (call) => (call.url.pathname.startsWith('/api/') ? body.clone() : undefined),
        },
      )
      await collect(session.item(fixture.items.login))
      await collect(session.snapshot())
    }
    await collect(
      createVaultClient({ fetch: replay(['badPassword']).fetch }).login({
        ...loginInput('dedicated'),
        masterPassword: 'not-the-password',
      }),
    )
    await collect(
      createVaultClient({ fetch: replay(['twoFactor.invalid']).fetch }).login({
        ...loginInput('twoFactor'),
        twoFactor: { provider: 'authenticator', code: '000000' },
      }),
    )
    expect(errors.length).toBeGreaterThan(8)
    for (const err of errors) {
      expect(err).toBeInstanceOf(VaultError)
      const text = `${(err as Error).message} ${String((err as Error).stack)} ${JSON.stringify(err)}`
      expect((err as Error).cause).toBeUndefined()
      for (const secret of [
        marker,
        fixture.accounts.dedicated.password,
        fixture.accounts.twoFactor.password,
        'not-the-password',
        refreshToken,
        accessToken,
        'Invalid TOTP',
        'Username or password',
      ]) {
        expect(text).not.toContain(secret)
      }
      expect((err as Error).message).not.toMatch(/\b[1-5]\d\d\b|E[A-Z]{3,}/)
    }
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(marker)
  })
})

describe('写入', () => {
  type Body = Record<string, unknown> & {
    name: string
    key: string | null
    notes: string | null
    revisionDate: string
    login: Record<string, unknown> & { password: string; username: string }
    fields: { type: number; name: string; value: string; linkedId: null }[] | null
    passwordHistory: { password: string; lastUsedDate: string }[] | null
  }

  const NOW = Date.parse('2026-11-07T12:00:00.000Z')
  const orgKey: SymmetricKey = decodeSync(
    syncBody('writer'),
    splitKey(Buffer.from(writerSecrets.userKey)),
  ).orgKeys.get(fixture.organizationId)!
  const dec = (enc: unknown, key = orgKey) => decryptText(enc as string, key)

  const recorded = (scenario: string, method: string, path: string) =>
    structuredClone(
      fixture.exchanges.find(
        (e) => e.scenario === scenario && e.method === method && e.path === path,
      )!.body,
    ) as Body
  const writeCalls = (calls: Call[]) =>
    calls.filter(
      (c) =>
        (c.init.method === 'POST' || c.init.method === 'PUT') &&
        c.url.pathname.startsWith('/api/ciphers'),
    )
  const sentBody = (calls: Call[], method: string) =>
    JSON.parse(
      String(writeCalls(calls).find((c) => c.init.method === method)!.init.body),
    ) as Body & {
      cipher: Body
      collectionIds: string[]
    }

  const writer = (
    scenario: string,
    options: VaultClientOptions & { override?: Override; scenarios?: string[] } = {},
  ) =>
    sessionOf(
      'writer',
      writerSecrets,
      {},
      { now: () => NOW, scenarios: ['writer.session', scenario], ...options },
    )

  const loginItem: VaultNewItem = {
    organizationId: fixture.organizationId,
    collectionId: fixture.collections.agent,
    type: 'login',
    name: 'kioku login',
    values: fixture.writes.createLogin,
    uris: [
      { uri: 'https://files.example.com:8443', autofill: true },
      { uri: 'https://api.example.com', autofill: false },
    ],
  }
  const createdLoginPath = `/api/ciphers/${fixture.items.createdLogin}`
  // 服务端没给 edit 的条目
  const omitEdit = (body: Body) => {
    const copy: Record<string, unknown> = { ...body }
    delete copy.edit
    return copy
  }
  // 取条目时给 raw，直到发出写入：写完再取的那次用录下的
  const withGet = (raw: unknown, path = createdLoginPath): Override => {
    let written = false
    return (call) => {
      if (writeCalls([call]).length) written = true
      return !written && call.init.method === 'GET' && call.url.pathname === path
        ? json(200, raw)
        : undefined
    }
  }

  it('新建登录条目：用组织密钥加密，放进集合，网址按主机加端口或不匹配，返回服务端给的条目', async () => {
    const { session, calls } = writer('writer.createLogin')
    const item = await session.createItem(loginItem)
    const response = recorded('writer.createLogin', 'POST', '/api/ciphers/create')
    expect(item).toMatchObject({
      id: fixture.items.createdLogin,
      type: 'login',
      name: 'kioku login',
      values: fixture.writes.createLogin,
      collectionIds: [fixture.collections.agent],
      revisionDate: response.revisionDate,
    })
    expect(writeCalls(calls).map((c) => c.url.pathname)).toEqual(['/api/ciphers/create'])
    const sent = sentBody(calls, 'POST')
    expect(sent.collectionIds).toEqual([fixture.collections.agent])
    const { cipher } = sent
    const snapshot = await session.snapshot()
    expect(cipher).toMatchObject({
      type: 1,
      organizationId: fixture.organizationId,
      encryptedFor: snapshot.account.userId,
      key: null,
      secureNote: null,
      notes: null,
      fields: null,
    })
    for (const enc of [cipher.name, cipher.login.username, cipher.login.password]) {
      expect(enc).toMatch(/^2\.[^|]+\|[^|]+\|[^|]+$/)
    }
    expect(dec(cipher.name)).toBe('kioku login')
    expect(dec(cipher.login.username)).toBe(fixture.writes.createLogin['login.username'])
    expect(dec(cipher.login.password)).toBe(fixture.writes.createLogin['login.password'])
    expect(cipher.login.totp).toBeNull()
    const uris = cipher.login.uris as { uri: string; uriChecksum: string; match: number }[]
    expect(uris.map((u) => [dec(u.uri), u.match])).toEqual([
      ['https://files.example.com:8443', 1],
      ['https://api.example.com', 5],
    ])
    for (const u of uris) {
      expect(dec(u.uriChecksum)).toBe(
        createHash('sha256').update(dec(u.uri), 'utf8').digest('base64'),
      )
    }
  })

  it('新建笔记：类型 2，自定义字段是隐藏字段', async () => {
    const { session, calls } = writer('writer.createNote')
    const item = await session.createItem({
      organizationId: fixture.organizationId,
      collectionId: fixture.collections.agent,
      type: 'note',
      name: 'kioku note',
      values: fixture.writes.createNote,
    })
    expect(item.values).toEqual(fixture.writes.createNote)
    const { cipher } = sentBody(calls, 'POST')
    expect(cipher).toMatchObject({ type: 2, secureNote: { type: 0 }, login: null })
    expect(dec(cipher.notes)).toBe(fixture.writes.createNote.notes)
    expect(cipher.fields!.map((f) => [f.type, dec(f.name), dec(f.value)])).toEqual([
      [1, 'token', fixture.writes.createNote['field:token']],
    ])
  })

  it('字段写法不对时在发请求之前报错：login.totp、不认识的字段、笔记的登录字段与网址', async () => {
    const { session, calls } = writer('writer.createLogin')
    for (const bad of [
      { ...loginItem, values: { 'login.totp': 'JBSWY3DPEHPK3PXP' } },
      { ...loginItem, values: { 'login.uri': 'x' } },
      { ...loginItem, values: { 'field:': 'x' } },
      { ...loginItem, type: 'note' as const, uris: [], values: { 'login.password': 'x' } },
      { ...loginItem, type: 'note' as const, values: { notes: 'x' } },
    ]) {
      expect(await kindOf(session.createItem(bad))).toBe('unsupported_format')
    }
    expect(
      await kindOf(
        session.updateItem(
          fixture.items.createdLogin,
          { values: { 'login.totp': 'x' } },
          '2026-01-01T00:00:00Z',
        ),
      ),
    ).toBe('unsupported_format')
    expect(calls).toHaveLength(0)
    // 笔记的登录字段要取到条目才知道类型：取了，不改
    const notePath = `/api/ciphers/${fixture.items.createdNote}`
    const note = writer('writer.createNote', {
      override: withGet(recorded('writer.createNote', 'POST', '/api/ciphers/create'), notePath),
    })
    const current = await note.session.item(fixture.items.createdNote)
    expect(
      await kindOf(
        note.session.updateItem(
          fixture.items.createdNote,
          { values: { 'login.password': 'x' } },
          current.revisionDate,
        ),
      ),
    ).toBe('unsupported_format')
    expect(writeCalls(note.calls)).toHaveLength(0)
  })

  it('同步里的集合只读或不在其中时，新建在发请求之前报 read_only', async () => {
    const viewer = sessionOf('dedicated', dedicatedSecrets)
    expect(await kindOf(viewer.session.createItem(loginItem))).toBe('read_only')
    const { session, calls } = writer('writer.createLogin')
    expect(
      await kindOf(session.createItem({ ...loginItem, collectionId: fixture.collections.other })),
    ).toBe('read_only')
    expect(
      await kindOf(session.createItem({ ...loginItem, organizationId: fixture.items.missing })),
    ).toBe('read_only')
    expect(writeCalls(calls)).toHaveLength(0)
    expect(writeCalls(viewer.calls)).toHaveLength(0)
  })

  it('缓存里没有的集合：重新同步一次再找', async () => {
    const withoutCollections = { ...syncBody('writer'), collections: [] }
    let syncs = 0
    const { session, calls } = writer('writer.createLogin', {
      override: (call) => {
        if (call.url.pathname !== '/api/sync') return undefined
        syncs++
        return syncs === 1 ? json(200, withoutCollections) : undefined
      },
    })
    await session.snapshot()
    expect((await session.createItem(loginItem)).id).toBe(fixture.items.createdLogin)
    expect(syncs).toBe(2)
    expect(writeCalls(calls)).toHaveLength(1)
  })

  it('修改只换给了的字段，其余原样带回；旧密码的密文进密码历史，新的在前、最多 5 条；不带附件数组', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const e = (v: string) => encryptText(v, orgKey)
    raw.login.fido2Credentials = [
      { credentialId: e('cred'), counter: e('0'), creationDate: '2026-01-01T00:00:00.000Z' },
    ]
    raw.passwordHistory = Array.from({ length: 5 }, (_, i) => ({
      password: e(`old-${i}`),
      lastUsedDate: '2026-01-01T00:00:00.000Z',
    }))
    raw.fields = [{ type: 0, name: e('region'), value: e('cn'), linkedId: null }]
    Object.assign(raw, {
      attachments: [{ id: 'a1', fileName: e('f'), key: null, size: '1', url: 'x' }],
      folderId: '0f0f0f0f-0000-4000-8000-000000000000',
      favorite: true,
      archivedDate: '2026-02-01T00:00:00.000Z',
      reprompt: 1,
    })
    const { session, calls } = writer('writer.update', { override: withGet(raw) })
    const item = await session.updateItem(
      fixture.items.createdLogin,
      { values: fixture.writes.update },
      raw.revisionDate,
    )
    const response = recorded('writer.update', 'PUT', createdLoginPath)
    expect(item.revisionDate).toBe(response.revisionDate)
    expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
    expect(item.collectionIds).toEqual([fixture.collections.agent])

    const put = calls.find((c) => c.init.method === 'PUT')!
    expect(put.url.pathname).toBe(createdLoginPath)
    const sent = JSON.parse(String(put.init.body)) as Body
    expect(dec(sent.login.password)).toBe(fixture.writes.update['login.password'])
    const now = new Date(NOW).toISOString()
    expect(sent.login.passwordRevisionDate).toBe(now)
    expect(sent.passwordHistory).toEqual([
      { password: raw.login.password, lastUsedDate: now },
      ...raw.passwordHistory.slice(0, 4),
    ])
    expect(sent.lastKnownRevisionDate).toBe(raw.revisionDate)
    expect(sent.encryptedFor).toBe((await session.snapshot()).account.userId)
    expect(sent).not.toHaveProperty('attachments')
    // 除了这几项，和取到的一模一样
    const strip = (b: Body) => {
      const rest: Record<string, unknown> = { ...b }
      for (const k of ['passwordHistory', 'attachments', 'lastKnownRevisionDate', 'encryptedFor']) {
        delete rest[k]
      }
      const login: Record<string, unknown> = { ...b.login }
      delete login.password
      delete login.passwordRevisionDate
      return { ...rest, login }
    }
    expect(strip(sent)).toEqual(strip(raw))
  })

  it('什么都没变时不发修改，返回现在的条目', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const { session, calls } = writer('writer.update')
    const current = await session.item(fixture.items.createdLogin)
    for (const changes of [
      {
        name: 'kioku login',
        values: {
          'login.password': fixture.writes.createLogin['login.password']!,
          'login.username': fixture.writes.createLogin['login.username']!,
        },
      },
      {},
      { values: {} },
    ]) {
      const item = await session.updateItem(fixture.items.createdLogin, changes, raw.revisionDate)
      expect(item).toEqual(current)
    }
    expect(writeCalls(calls)).toHaveLength(0)
  })

  it('改了一项时，值没变的别的字段不换密文，也不记历史', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const { session, calls } = writer('writer.update')
    await session.updateItem(
      fixture.items.createdLogin,
      {
        name: 'kioku login',
        values: {
          'login.password': fixture.writes.createLogin['login.password']!,
          'login.username': fixture.writes.createLogin['login.username']!,
          notes: 'changed',
        },
      },
      raw.revisionDate,
    )
    const sent = sentBody(calls, 'PUT')
    expect(dec(sent.notes)).toBe('changed')
    expect(sent.name).toBe(raw.name)
    expect(sent.login.password).toBe(raw.login.password)
    expect(sent.login.username).toBe(raw.login.username)
    expect(sent.passwordHistory).toEqual(raw.passwordHistory)
    expect(sent.login.passwordRevisionDate).toBe(raw.login.passwordRevisionDate)
  })

  it('改名称、用户名与备注只换这几项；没有旧密码时改密码不记历史', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    raw.login.password = null as unknown as string
    const { session, calls } = writer('writer.update', { override: withGet(raw) })
    await session.updateItem(
      fixture.items.createdLogin,
      { name: 'renamed', values: { 'login.username': 'u2', notes: 'n2', 'login.password': 'p' } },
      raw.revisionDate,
    )
    const sent = sentBody(calls, 'PUT')
    expect([
      dec(sent.name),
      dec(sent.login.username),
      dec(sent.notes),
      dec(sent.login.password),
    ]).toEqual(['renamed', 'u2', 'n2', 'p'])
    expect(sent.passwordHistory).toEqual(raw.passwordHistory)
  })

  it('自定义字段按名字找：找到只换值，隐藏字段的旧值进历史；没有就加一个隐藏字段', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const e = (v: string) => encryptText(v, orgKey)
    raw.fields = [
      { type: 0, name: e('region'), value: e('cn-north'), linkedId: null },
      { type: 3, name: e('api token'), value: null as unknown as string, linkedId: null },
      { type: 1, name: e('api token'), value: e('old-token'), linkedId: null },
      { type: 2, name: e('flag'), value: e('true'), linkedId: null },
    ]
    const { session, calls } = writer('writer.update', { override: withGet(raw) })
    await session.updateItem(
      fixture.items.createdLogin,
      { values: { 'field:api token': 'new-token', 'field:region': 'eu', 'field:added': 'v' } },
      raw.revisionDate,
    )
    const fields = sentBody(calls, 'PUT').fields!
    expect(fields).toHaveLength(5)
    for (const i of [0, 1, 2, 3]) {
      expect(fields[i]!.name).toBe(raw.fields[i]!.name)
      expect(fields[i]!.type).toBe(raw.fields[i]!.type)
    }
    expect(dec(fields[0]!.value)).toBe('eu')
    expect(fields[1]).toEqual(raw.fields[1])
    expect(dec(fields[2]!.value)).toBe('new-token')
    expect(fields[3]).toEqual(raw.fields[3])
    expect([fields[4]!.type, dec(fields[4]!.name), dec(fields[4]!.value)]).toEqual([
      1,
      'added',
      'v',
    ])
    // 只有隐藏字段的旧值进历史；文本字段不记
    const history = sentBody(calls, 'PUT').passwordHistory!
    expect(history.map((h) => dec(h.password))).toEqual(['api token: old-token'])
  })

  it('几个隐藏字段改了时，按字段在条目里的顺序逐个插到最前面（同官方客户端），旧密码在它们后面', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const e = (v: string) => encryptText(v, orgKey)
    raw.fields = [
      { type: 1, name: e('a'), value: e('old-a'), linkedId: null },
      { type: 1, name: e('b'), value: e('old-b'), linkedId: null },
    ]
    const { session, calls } = writer('writer.update', { override: withGet(raw) })
    await session.updateItem(
      fixture.items.createdLogin,
      { values: { 'field:b': 'new-b', 'login.password': 'new-password', 'field:a': 'new-a' } },
      raw.revisionDate,
    )
    const history = sentBody(calls, 'PUT').passwordHistory!
    expect(history.map((h) => dec(h.password))).toEqual([
      'b: old-b',
      'a: old-a',
      fixture.writes.createLogin['login.password'],
    ])
  })

  // 官方服务的 /api/config 里 server 为空
  const officialConfig: Override = (call) =>
    call.url.pathname === '/api/config'
      ? json(200, { server: null, version: '2026.10.0' })
      : undefined

  it('官方服务：加密之后超出长度上限时发请求之前报 value_too_long，文字不带值', async () => {
    const { session, calls } = writer('writer.update', { override: officialConfig })
    const long = (n: number) => 'x'.repeat(n)
    const cases: [Partial<VaultNewItem>, string][] = [
      [{ name: long(700) }, '名称'],
      [{ values: { 'login.username': long(700) } }, '用户名'],
      [{ values: { 'login.password': long(3700) } }, '密码'],
      [{ values: { notes: long(7500) } }, '备注'],
      [{ values: { 'field:token': long(3700) } }, '自定义字段的值'],
      [{ values: { [`field:${long(700)}`]: 'v' } }, '自定义字段名'],
      [{ uris: [{ uri: long(7500), autofill: true }] }, '网址'],
    ]
    for (const [change, label] of cases) {
      const err = await errorOf(session.createItem({ ...loginItem, ...change }))
      expect(err.kind).toBe('value_too_long')
      expect(err.message).toContain(label)
      expect(err.message).not.toContain('xxxx')
    }
    // 不到上限的照常
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    expect(
      await kindOf(
        session.updateItem(
          fixture.items.createdLogin,
          { values: { notes: long(7500) } },
          raw.revisionDate,
        ),
      ),
    ).toBe('value_too_long')
    expect(writeCalls(calls)).toHaveLength(0)
    const ok = await session.updateItem(
      fixture.items.createdLogin,
      { values: { notes: long(7000) } },
      raw.revisionDate,
    )
    expect(ok.id).toBe(fixture.items.createdLogin)
    expect(writeCalls(calls)).toHaveLength(1)
  })

  it('Vaultwarden 只限备注：长的密码、令牌与名称照常写；服务器配置只读一次；读不到时按官方的上限', async () => {
    const long = (n: number) => 'x'.repeat(n)
    const { session, calls } = writer('writer.createLogin')
    for (const change of [
      { name: long(3000) },
      { values: { 'login.password': long(6000) } },
      { values: { 'field:private key': long(6000) } },
    ]) {
      expect((await session.createItem({ ...loginItem, ...change })).id).toBe(
        fixture.items.createdLogin,
      )
    }
    expect(await kindOf(session.createItem({ ...loginItem, values: { notes: long(7500) } }))).toBe(
      'value_too_long',
    )
    expect(writeCalls(calls)).toHaveLength(3)
    expect(calls.filter((c) => c.url.pathname === '/api/config')).toHaveLength(1)

    // 读不到配置：这一次按官方的上限，下次再读
    let configs = 0
    const failing = writer('writer.createLogin', {
      override: (call) =>
        call.url.pathname === '/api/config' && ++configs === 1 ? json(500, {}) : undefined,
    })
    const password = { ...loginItem, values: { 'login.password': long(6000) } }
    expect(await kindOf(failing.session.createItem(password))).toBe('value_too_long')
    expect((await failing.session.createItem(password)).id).toBe(fixture.items.createdLogin)
    expect(configs).toBe(2)
  })

  it('隐藏字段的旧值记进历史会超长时：不记这一条，修改照常，日志不带值', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const old = 'o'.repeat(3700)
    raw.fields = [
      {
        type: 1,
        name: encryptText('api token', orgKey),
        value: encryptText(old, orgKey),
        linkedId: null,
      },
    ]
    const log = vi.fn()
    const getRaw = withGet(raw)
    const { session, calls } = writer('writer.update', {
      log,
      override: (call, recordedExchange) =>
        officialConfig(call, recordedExchange) ?? getRaw(call, recordedExchange),
    })
    await session.updateItem(
      fixture.items.createdLogin,
      { values: { 'field:api token': 'new-token', 'login.password': 'new-password' } },
      raw.revisionDate,
    )
    const sent = sentBody(calls, 'PUT')
    expect(dec(sent.fields![0]!.value)).toBe('new-token')
    // 旧密码照样记，隐藏字段的那条不记
    expect(sent.passwordHistory).toEqual([
      { password: raw.login.password, lastUsedDate: new Date(NOW).toISOString() },
    ])
    expect(log).toHaveBeenCalledWith({ what: 'history_skipped', endpoint: 'cipher_update' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('ooo')
  })

  it('有条目密钥的条目用条目密钥加密，条目密钥原样带回', async () => {
    const path = `/api/ciphers/${fixture.items.itemKey}`
    const raw = recorded('writer.updateItemKey', 'GET', path)
    const { session, calls } = writer('writer.updateItemKey')
    const item = await session.updateItem(
      fixture.items.itemKey,
      { values: fixture.writes.updateItemKey },
      raw.revisionDate,
    )
    expect(item.values['login.password']).toBe(fixture.writes.updateItemKey['login.password'])
    const sent = sentBody(calls, 'PUT')
    expect(sent.key).toBe(raw.key)
    const itemKey = splitKey(decryptBytes(raw.key!, orgKey))
    expect(dec(sent.login.password, itemKey)).toBe(fixture.writes.updateItemKey['login.password'])
    expect(() => dec(sent.login.password)).toThrow()
    expect(sent.passwordHistory![0]!.password).toBe(raw.login.password)
  })

  it('修改时间和读到时不同：报 item_conflict，不发修改', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const { session, calls } = writer('writer.update')
    for (const expected of ['2020-01-01T00:00:00.000000Z', raw.revisionDate.replace('Z', '')]) {
      expect(
        await kindOf(
          session.updateItem(fixture.items.createdLogin, { values: { notes: 'x' } }, expected),
        ),
      ).toBe('item_conflict')
    }
    expect(writeCalls(calls)).toHaveLength(0)
  })

  it('条目不可编辑（edit 为 false）或所在的集合都只读：报 read_only，不发修改', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const notEditable = writer('writer.update', { override: withGet({ ...raw, edit: false }) })
    const readOnlySync = syncBody('writer') as unknown as { collections: { readOnly: boolean }[] }
    for (const c of readOnlySync.collections) c.readOnly = true
    // 服务端没给 edit 时才看缓存里的集合
    const withoutEdit = omitEdit(raw)
    const readOnlyCollections = writer('writer.update', {
      override: (call) =>
        call.url.pathname === '/api/sync'
          ? json(200, readOnlySync)
          : withGet(withoutEdit)(call, undefined),
    })
    for (const { session, calls } of [notEditable, readOnlyCollections]) {
      expect(
        await kindOf(
          session.updateItem(
            fixture.items.createdLogin,
            { values: { notes: 'x' } },
            raw.revisionDate,
          ),
        ),
      ).toBe('read_only')
      expect(writeCalls(calls)).toHaveLength(0)
    }
    // 只读的专用账号：录下的同步里集合只读
    const viewer = sessionOf('dedicated', dedicatedSecrets)
    const login = await viewer.session.item(fixture.items.login)
    expect(
      await kindOf(
        viewer.session.updateItem(
          fixture.items.login,
          { values: { notes: 'x' } },
          login.revisionDate,
        ),
      ),
    ).toBe('read_only')
    expect(writeCalls(viewer.calls)).toHaveLength(0)
  })

  it('缓存说只读、刚取到的条目 edit 为 true：照常修改；不知道条目在哪些集合时不据缓存判只读', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const readOnlySync = syncBody('writer') as unknown as {
      collections: { readOnly: boolean }[]
      ciphers: { id: string }[]
    }
    for (const c of readOnlySync.collections) c.readOnly = true
    const withoutEdit = omitEdit(raw)
    for (const got of [
      { ...raw, edit: true },
      { ...withoutEdit, collectionIds: [] },
    ]) {
      const getGot = withGet(got)
      const { session, calls } = writer('writer.update', {
        override: (call) =>
          call.url.pathname === '/api/sync' ? json(200, readOnlySync) : getGot(call, undefined),
      })
      expect((await session.snapshot()).collections.every((c) => c.readOnly)).toBe(true)
      const item = await session.updateItem(
        fixture.items.createdLogin,
        { values: fixture.writes.update },
        raw.revisionDate,
      )
      expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
      expect(writeCalls(calls)).toHaveLength(1)
    }
  })

  it('缓存说集合只读时，新建先重新同步一次：已经改成可以编辑就照常新建', async () => {
    const readOnlySync = syncBody('writer') as unknown as { collections: { readOnly: boolean }[] }
    for (const c of readOnlySync.collections) c.readOnly = true
    let syncs = 0
    let clock = NOW
    const { session, calls } = writer('writer.createLogin', {
      now: () => clock,
      override: (call) => {
        if (call.url.pathname !== '/api/sync') return undefined
        syncs++
        return syncs === 1 ? json(200, readOnlySync) : undefined
      },
    })
    await session.snapshot()
    // 上次同步不到 60 秒：直接按只读报，不重新同步（agent 循环重试时不会每次都下载整个密码库）
    clock += 30_000
    expect(await kindOf(session.createItem(loginItem))).toBe('read_only')
    expect(syncs).toBe(1)
    clock += 31_000
    expect((await session.createItem(loginItem)).id).toBe(fixture.items.createdLogin)
    expect(syncs).toBe(2)
    expect(writeCalls(calls)).toHaveLength(1)
    // 重新同步之后还是只读：不发请求
    let stillClock = NOW
    const still = writer('writer.createLogin', {
      now: () => stillClock,
      override: (call) => (call.url.pathname === '/api/sync' ? json(200, readOnlySync) : undefined),
    })
    await still.session.snapshot()
    stillClock += 61_000
    expect(await kindOf(still.session.createItem(loginItem))).toBe('read_only')
    expect(writeCalls(still.calls)).toHaveLength(0)
  })

  it('服务端不给 edit、缓存说只读：上次同步过了 60 秒就重新同步一次再判断', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const readOnlySync = syncBody('writer') as unknown as { collections: { readOnly: boolean }[] }
    for (const c of readOnlySync.collections) c.readOnly = true
    let syncs = 0
    let clock = NOW
    const getWithoutEdit = withGet(omitEdit(raw))
    const { session, calls } = writer('writer.update', {
      now: () => clock,
      override: (call) => {
        if (call.url.pathname === '/api/sync') {
          syncs++
          return syncs === 1 ? json(200, readOnlySync) : undefined
        }
        return getWithoutEdit(call, undefined)
      },
    })
    await session.snapshot()
    const change = { values: fixture.writes.update }
    expect(
      await kindOf(session.updateItem(fixture.items.createdLogin, change, raw.revisionDate)),
    ).toBe('read_only')
    expect(syncs).toBe(1)
    clock += 61_000
    const item = await session.updateItem(fixture.items.createdLogin, change, raw.revisionDate)
    expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
    expect(syncs).toBe(2)
    expect(writeCalls(calls)).toHaveLength(1)
  })

  it('新建时记下的集合在下一次同步之后不再用：条目被移到别的集合时报新的集合', async () => {
    const created = recorded('writer.createLogin', 'POST', '/api/ciphers/create')
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const moved = syncBody('writer') as unknown as { ciphers: unknown[] }
    moved.ciphers.push({ ...created, collectionIds: [fixture.collections.other] })
    let synced = false
    const { session } = writer('writer.createLogin', {
      scenarios: ['writer.session', 'writer.createLogin', 'writer.update'],
      override: (call) => {
        if (call.url.pathname === '/api/ciphers/create') {
          return json(200, { ...created, collectionIds: [] })
        }
        if (call.url.pathname === '/api/sync' && synced) return json(200, moved)
        return withGet({ ...omitEdit(raw), collectionIds: [] })(call, undefined)
      },
    })
    const item = await session.createItem(loginItem)
    expect((await session.item(item.id)).collectionIds).toEqual([fixture.collections.agent])
    synced = true
    await session.snapshot()
    expect((await session.item(item.id)).collectionIds).toEqual([fixture.collections.other])
    // 同步里也没有它（别处删了又看不到了）：不再报新建时的集合
    synced = false
    await session.snapshot()
    expect((await session.item(item.id)).collectionIds).toEqual([])
  })

  it('新建之后马上取、马上改：单个条目与同步都不带集合时，用新建时记下的集合', async () => {
    const created = recorded('writer.createLogin', 'POST', '/api/ciphers/create')
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const withoutEdit = omitEdit(raw)
    const { session, calls } = writer('writer.createLogin', {
      scenarios: ['writer.session', 'writer.createLogin', 'writer.update'],
      override: (call) => {
        if (call.url.pathname === '/api/ciphers/create') {
          return json(200, { ...created, collectionIds: [] })
        }
        if (call.init.method === 'PUT') {
          return json(200, {
            ...recorded('writer.update', 'PUT', createdLoginPath),
            collectionIds: [],
          })
        }
        return withGet({ ...withoutEdit, collectionIds: [] })(call, undefined)
      },
    })
    const item = await session.createItem(loginItem)
    expect(item.collectionIds).toEqual([fixture.collections.agent])
    expect((await session.item(item.id)).collectionIds).toEqual([fixture.collections.agent])
    const updated = await session.updateItem(
      item.id,
      { values: fixture.writes.update },
      raw.revisionDate,
    )
    expect(updated.collectionIds).toEqual([fixture.collections.agent])
    expect(writeCalls(calls)).toHaveLength(2)
  })

  it('每个请求都带客户端的名字与版本；官方服务嫌版本旧时报说得清的错误', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const { session, calls } = writer('writer.update', {
      override: (call) =>
        call.init.method === 'PUT'
          ? json(400, {
              message: 'Cannot edit item. Update to the latest version of Bitwarden and try again.',
            })
          : undefined,
    })
    const err = await errorOf(
      session.updateItem(fixture.items.createdLogin, { values: { notes: 'x' } }, raw.revisionDate),
    )
    expect(err.kind).toBe('server_error')
    expect(err.message).toContain('客户端版本')
    expect(err.message).not.toContain('Cannot edit')
    expect(calls.length).toBeGreaterThan(2)
    for (const call of calls) {
      const headers = call.init.headers as Record<string, string>
      expect(headers['bitwarden-client-name']).toBe('cli')
      expect(headers['bitwarden-client-version']).toBe(CLIENT_VERSION)
    }
  })

  it('集合被删、账号被移出集合（Invalid collection ID）：种类是 read_only，文字说集合不可用', async () => {
    const { session } = writer('writer.createLogin', {
      override: (call) =>
        call.url.pathname === '/api/ciphers/create'
          ? json(400, { message: 'Invalid collection ID provided' })
          : undefined,
    })
    const err = await errorOf(session.createItem(loginItem))
    expect(err.kind).toBe('read_only')
    expect(err.message).toContain('集合不可用')
    expect(err.message).not.toContain('只读')
  })

  it('服务端拒绝写入：Vaultwarden 与官方服务的说法分别映射成 read_only、item_conflict、item_unavailable；说明不进错误与日志', async () => {
    // Vaultwarden 录下的：同步被改成可以编辑，由服务端自己拒绝
    const log = vi.fn()
    const viewer = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      { scenarios: ['dedicated.readOnly'], log },
    )
    expect(await kindOf(viewer.session.createItem(loginItem))).toBe('read_only')
    const login = await viewer.session.item(fixture.items.login)
    expect(
      await kindOf(
        viewer.session.updateItem(
          fixture.items.login,
          { values: { notes: 'x' } },
          login.revisionDate,
        ),
      ),
    ).toBe('read_only')
    expect(writeCalls(viewer.calls)).toHaveLength(2)
    const stale = '2020-01-01T00:00:00.000000Z'
    const conflict = writer('writer.conflict', { log })
    expect(
      await kindOf(
        conflict.session.updateItem(fixture.items.createdLogin, { values: { notes: 'x' } }, stale),
      ),
    ).toBe('item_conflict')
    expect(writeCalls(conflict.calls)).toHaveLength(1)

    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const cases: [Response, string][] = [
      [json(400, { message: 'You do not have permissions to edit this.' }), 'read_only'],
      [json(403, {}), 'read_only'],
      [
        json(400, {
          message:
            'The cipher you are updating is out of date. Please save your work, sync your vault, and try again.',
        }),
        'item_conflict',
      ],
      [json(404, {}), 'item_unavailable'],
      [json(400, { message: "Cipher doesn't exist" }), 'item_unavailable'],
      [json(400, { message: 'Something else' }), 'server_error'],
      [json(500, { message: 'out of date' }), 'server_error'],
    ]
    const errors: VaultError[] = []
    for (const [response, kind] of cases) {
      const { session } = writer('writer.update', {
        log,
        override: (call) => (call.init.method === 'PUT' ? response.clone() : undefined),
      })
      const err = await errorOf(
        session.updateItem(
          fixture.items.createdLogin,
          { values: { notes: 'x' } },
          raw.revisionDate,
        ),
      )
      expect(err.kind).toBe(kind)
      errors.push(err)
    }
    const shown = JSON.stringify([...errors.map((e) => e.message), ...log.mock.calls])
    for (const text of [
      'permissions to edit',
      'out of date',
      "doesn't exist",
      'Something else',
      'not write accessible',
      'No rights',
    ]) {
      expect(shown).not.toContain(text)
    }
    expect(log).toHaveBeenCalledWith({
      what: 'rejected',
      status: 400,
      endpoint: 'cipher_update',
      problem: 'conflict',
    })
  })

  // 写完再取的那份：录下的这个场景里，这个条目最后一次 GET
  const reread = (scenario: string, path: string) =>
    structuredClone(
      fixture.exchanges.findLast(
        (e) => e.scenario === scenario && e.method === 'GET' && e.path === path,
      )!.body,
    ) as Body

  // MySQL 的 DATETIME 不带小数秒：写入响应里带着小数，存下的（之后同步与取条目给的）是整秒
  const wholeSecond = (date: string) => date.replace(/\.\d+Z$/, '.000000Z')
  const fractional = (date: string) => date.replace(/\.\d+Z$/, '.678901Z')

  it('写入之后再取一次：修改时间以库里存下的为准，紧接着再改不报冲突', async () => {
    const put = recorded('writer.update', 'PUT', createdLoginPath)
    const after = reread('writer.update', createdLoginPath)
    const stored = wholeSecond(after.revisionDate)
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    let written = false
    const mysql = writer('writer.update', {
      override: (call) => {
        if (call.url.pathname !== createdLoginPath) return undefined
        if (call.init.method === 'PUT') {
          written = true
          return json(200, { ...put, revisionDate: fractional(put.revisionDate) })
        }
        return json(200, written ? { ...after, revisionDate: stored } : raw)
      },
    })
    const item = await mysql.session.updateItem(
      fixture.items.createdLogin,
      { values: fixture.writes.update },
      raw.revisionDate,
    )
    expect(item.revisionDate).toBe(stored)
    expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
    expect(item.collectionIds).toEqual([fixture.collections.agent])
    // 拿返回的修改时间紧接着再改：取到的还是整秒的那个，不报冲突
    const again = await mysql.session.updateItem(
      fixture.items.createdLogin,
      { values: { notes: 'again' } },
      item.revisionDate,
    )
    expect(again.revisionDate).toBe(stored)
    expect(writeCalls(mysql.calls)).toHaveLength(2)
  })

  it('新建之后也再取一次：修改时间以库里存下的为准，集合照新建时的', async () => {
    const created = recorded('writer.createLogin', 'POST', '/api/ciphers/create')
    const after = reread('writer.createLogin', createdLoginPath)
    const stored = wholeSecond(after.revisionDate)
    const { session } = writer('writer.createLogin', {
      override: (call) => {
        if (call.url.pathname === '/api/ciphers/create') {
          return json(200, { ...created, revisionDate: fractional(created.revisionDate) })
        }
        if (call.init.method === 'GET' && call.url.pathname === createdLoginPath) {
          // Vaultwarden 给非管理员的单个条目可能不带集合
          return json(200, { ...after, revisionDate: stored, collectionIds: [] })
        }
        return undefined
      },
    })
    const item = await session.createItem(loginItem)
    expect(item.revisionDate).toBe(stored)
    expect(item.collectionIds).toEqual([fixture.collections.agent])
  })

  it('写完再取失败（意外的状态、连不上、解不开）时退回写入响应的那一份，日志记一条不带值；401 换令牌再取', async () => {
    const put = recorded('writer.update', 'PUT', createdLoginPath)
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    const failures: (() => Response)[] = [
      () => json(500, { message: 'secret-marker' }),
      () => {
        throw new TypeError('fetch failed')
      },
      () => json(200, { ...raw, name: '2.AAAA|BBBB|CCCC' }),
    ]
    for (const fail of failures) {
      const log = vi.fn()
      let written = false
      const { session } = writer('writer.update', {
        log,
        override: (call) => {
          if (call.url.pathname !== createdLoginPath) return undefined
          if (call.init.method === 'PUT') {
            written = true
            return undefined
          }
          return written ? fail() : json(200, raw)
        },
      })
      const item = await session.updateItem(
        fixture.items.createdLogin,
        { values: fixture.writes.update },
        raw.revisionDate,
      )
      expect(item.revisionDate).toBe(put.revisionDate)
      expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ what: 'reread_failed' }))
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret-marker')
    }

    let rereads = 0
    let written = false
    const { session, calls } = writer('writer.update', {
      override: (call) => {
        if (call.url.pathname !== createdLoginPath) return undefined
        if (call.init.method === 'PUT') {
          written = true
          return undefined
        }
        if (!written) return json(200, raw)
        return ++rereads === 1 ? json(401, {}) : undefined
      },
    })
    const item = await session.updateItem(
      fixture.items.createdLogin,
      { values: fixture.writes.update },
      raw.revisionDate,
    )
    expect(rereads).toBe(2)
    expect(item.revisionDate).toBe(reread('writer.update', createdLoginPath).revisionDate)
    expect(tokenCalls(calls)).toHaveLength(2)
    expect(writeCalls(calls)).toHaveLength(1)
  })

  it('修改与新建遇到 401 时换令牌、重新取条目再写', async () => {
    const raw = recorded('writer.update', 'GET', createdLoginPath)
    let puts = 0
    let posts = 0
    const { session, calls } = writer('writer.update', {
      scenarios: ['writer.session', 'writer.update', 'writer.createLogin'],
      override: (call) => {
        if (call.init.method === 'PUT' && ++puts === 1) return json(401, {})
        if (call.url.pathname === '/api/ciphers/create' && ++posts === 1) return json(401, {})
        return undefined
      },
    })
    await session.snapshot()
    const item = await session.updateItem(
      fixture.items.createdLogin,
      { values: fixture.writes.update },
      raw.revisionDate,
    )
    expect(item.values['login.password']).toBe(fixture.writes.update['login.password'])
    expect(puts).toBe(2)
    const gets = calls.filter((c) => c.init.method === 'GET' && c.url.pathname === createdLoginPath)
    // 取一次、401 之后再取一次、写完再取一次
    expect(gets).toHaveLength(3)
    expect((await session.createItem(loginItem)).id).toBe(fixture.items.createdLogin)
    expect(posts).toBe(2)
    expect(tokenCalls(calls)).toHaveLength(3)
  })
})
