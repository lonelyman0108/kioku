import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { createVaultClient, type VaultClientOptions } from '../client'
import { vaultEndpoints } from '../http'
import {
  VaultError,
  type VaultLoginInput,
  type VaultSecrets,
  type VaultSessionInput,
  type VaultSnapshot,
} from '../types'
import type { RecordedExchange } from '../../../testing/recordVaultFixtures'

// 用本地 Vaultwarden 录下的响应（src/testing/recordVaultFixtures.ts 生成）回放。账号与密码都是测试数据

interface Fixture {
  server: string
  accounts: Record<
    'dedicated' | 'member' | 'twoFactor',
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
  }
  values: Record<'login' | 'note' | 'itemKey' | 'bw' | 'bwItemKey', Record<string, string>>
  exchanges: RecordedExchange[]
}

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

// 按场景回放：方法、路径与 grant_type 对得上的第一条。密码登录时核对发出的主密码哈希和录下的一样（验证 KDF）
function replay(scenarios: string[], override?: Override) {
  const calls: Call[] = []
  const fetchFn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const form = url.pathname.endsWith('/connect/token')
      ? Object.fromEntries(new URLSearchParams(String(init.body)))
      : null
    const call = { url, init, form }
    calls.push(call)
    const recorded = fixture.exchanges.find(
      (e) =>
        scenarios.includes(e.scenario) &&
        e.method === (init.method ?? 'GET') &&
        e.path === url.pathname &&
        (e.form?.grant_type ?? null) === (form?.grant_type ?? null),
    )
    const replaced = override?.(call, recorded)
    if (replaced) return replaced
    if (!recorded) throw new Error(`没有录下的响应：${init.method} ${url.pathname}`)
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

async function loginSecrets(name: 'dedicated' | 'member'): Promise<VaultSecrets> {
  const { fetch } = replay([`${name}.login`])
  const result = await createVaultClient({ fetch }).login(loginInput(name))
  if (result.kind !== 'ok') throw new Error('登录失败')
  return result.secrets
}

function sessionOf(
  name: 'dedicated' | 'member',
  secrets: VaultSecrets,
  extra: Partial<VaultSessionInput> = {},
  options: VaultClientOptions & { override?: Override } = {},
) {
  const r = replay([`${name}.session`], options.override)
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

  it('邮件验证码映射成 email，不认识的方式不列出；都不认识时报 unsupported_two_factor', async () => {
    const withProviders = (providers: Record<string, null>) =>
      replay(['dedicated.login'], (call) =>
        call.form
          ? json(400, {
              error: 'invalid_grant',
              error_description: 'Two factor required.',
              TwoFactorProviders2: providers,
            })
          : undefined,
      ).fetch
    const both = await createVaultClient({
      fetch: withProviders({ '1': null, '0': null, '3': null }),
    }).login(loginInput('dedicated'))
    expect(both).toEqual({ kind: 'two_factor_required', providers: ['authenticator', 'email'] })
    const none = createVaultClient({ fetch: withProviders({ '3': null, '7': null }) }).login(
      loginInput('dedicated'),
    )
    expect(await kindOf(none)).toBe('unsupported_two_factor')
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
    expect(await kindOf(createVaultClient({ fetch }).login(loginInput('dedicated')))).toBe(
      'unsupported_two_factor',
    )
  })

  it('KDF 参数超出范围报 unsupported_format，不发登录请求', async () => {
    const { fetch, calls } = replay(['dedicated.login'], (call) =>
      call.url.pathname.endsWith('/prelogin')
        ? json(200, { kdf: 0, kdfIterations: 1_000_000_000 })
        : undefined,
    )
    expect(await kindOf(createVaultClient({ fetch }).login(loginInput('dedicated')))).toBe(
      'unsupported_format',
    )
    expect(calls.some((c) => c.form)).toBe(false)
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

function syncBody(name: 'dedicated' | 'member') {
  return structuredClone(
    fixture.exchanges.find((e) => e.scenario === `${name}.session` && e.path === '/api/sync')!.body,
  ) as {
    profile: { organizations: { key: string; type: number }[] }
    collections: { name: string }[]
    ciphers: {
      id: string
      name: string
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
      expect.objectContaining({ id: fixture.organizationId, role: 'user' }),
    ])
    expect(snapshot.collections).toEqual([
      { id: fixture.collections.agent, organizationId: fixture.organizationId, name: 'Agent' },
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
    expect(snapshot.organizations[0]?.role).toBe('owner')
    expect(snapshot.collections.map((c) => c.name).sort()).toEqual(['Agent', 'Private'])
    expect(snapshot.personalItemCount).toBe(1)
    expect(snapshot.items.map((i) => i.id)).toContain(fixture.items.hidden)
    expect(snapshot.items.map((i) => i.id)).not.toContain(fixture.items.trashed)
  })

  it('不认识的组织角色不当作普通成员', async () => {
    const body = syncBody('dedicated')
    body.profile.organizations[0]!.type = 9
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        override: (call) => (call.url.pathname === '/api/sync' ? json(200, body) : undefined),
      },
    )
    expect(await kindOf(session.snapshot())).toBe('server_error')
  })

  it('条目名称的 MAC 被改过时报 integrity', async () => {
    const body = syncBody('dedicated')
    const cipher = body.ciphers.find((c) => c.id === fixture.items.login)!
    cipher.name = tamperMac(cipher.name)
    const { session } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        override: (call) => (call.url.pathname === '/api/sync' ? json(200, body) : undefined),
      },
    )
    expect(await kindOf(session.snapshot())).toBe('integrity')
  })

  it('不认识的加密格式报 unsupported_format：类型 0、1、未知类型，组织密钥的类型 6', async () => {
    const cases: ((b: ReturnType<typeof syncBody>) => void)[] = [
      (b) => {
        const c = b.ciphers.find((x) => x.id === fixture.items.login)!
        c.name = `0.${c.name.slice(2).split('|').slice(0, 2).join('|')}`
      },
      (b) => {
        const c = b.ciphers.find((x) => x.id === fixture.items.login)!
        c.name = `1.${c.name.slice(2)}`
      },
      (b) => {
        b.collections[0]!.name = `8.${b.collections[0]!.name.slice(2)}`
      },
      (b) => {
        const org = b.profile.organizations[0]!
        org.key = `6.${org.key.slice(2)}|AAAA`
      },
    ]
    for (const mutate of cases) {
      const body = syncBody('dedicated')
      mutate(body)
      const { session } = sessionOf(
        'dedicated',
        dedicatedSecrets,
        {},
        {
          override: (call) => (call.url.pathname === '/api/sync' ? json(200, body) : undefined),
        },
      )
      expect(await kindOf(session.snapshot())).toBe('unsupported_format')
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
    // 令牌没过期：再取不换令牌；列出条目时重新同步，但不再调用 onSynced
    await session.item(fixture.items.itemKey)
    await session.snapshot()
    expect(tokenCalls(calls)).toHaveLength(1)
    expect(calls.filter((c) => c.url.pathname === '/api/sync')).toHaveLength(2)
    expect(onSynced).toHaveBeenCalledTimes(1)
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

  it('onSecretsChanged 抛错时调用失败，下一次用新的刷新令牌换', async () => {
    let rotations = 0
    const failure = new Error('保存失败')
    const onSecretsChanged = vi.fn(async () => {
      if (onSecretsChanged.mock.calls.length === 1) throw failure
    })
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      { onSecretsChanged },
      {
        override: (call, recorded) => {
          if (call.form?.grant_type !== 'refresh_token' || !recorded) return undefined
          rotations++
          return json(200, { ...(recorded.body as object), refresh_token: `rotated-${rotations}` })
        },
      },
    )
    await expect(session.snapshot()).rejects.toBe(failure)
    await session.snapshot()
    expect(tokenCalls(calls)[1]!.form!.refresh_token).toBe('rotated-1')
  })
})

describe('网络', () => {
  it('每个请求都不跟随重定向；3xx 报 server_error', async () => {
    const { session, calls } = sessionOf(
      'dedicated',
      dedicatedSecrets,
      {},
      {
        override: (call) =>
          call.url.pathname === '/api/sync'
            ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
            : undefined,
      },
    )
    const err = await errorOf(session.snapshot())
    expect(err.kind).toBe('server_error')
    expect(err.message).toContain('重定向（302）')
    expect(err.message).not.toContain('10.0.0.1')
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

  it('连不上时只写错误代码', async () => {
    const refuse = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed: Authorization Bearer leaked-token'), {
        cause: { code: 'ECONNREFUSED' },
      })
    })
    const err = await errorOf(
      createVaultClient({ fetch: refuse as unknown as typeof fetch }).login(
        loginInput('dedicated'),
      ),
    )

    expect(err.kind).toBe('unreachable')
    expect(err.message).toContain('ECONNREFUSED')
    expect(err.message).not.toContain('leaked-token')
    expect(err.cause).toBeUndefined()
  })

  it('意外的状态码与不是 JSON 的响应报 server_error', async () => {
    for (const res of [json(500, { message: 'boom' }), new Response('<html>', { status: 200 })]) {
      const { fetch } = replay(['dedicated.login'], () => res.clone())
      expect(await kindOf(createVaultClient({ fetch }).login(loginInput('dedicated')))).toBe(
        'server_error',
      )
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
  })
})

describe('错误信息', () => {
  it('不带主密码、令牌与响应正文', async () => {
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
        createVaultClient({ fetch: replay(['dedicated.login'], () => body.clone()).fetch }).login(
          loginInput('dedicated'),
        ),
      )
      const { session } = sessionOf(
        'dedicated',
        dedicatedSecrets,
        {},
        {
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
    }
  })
})
