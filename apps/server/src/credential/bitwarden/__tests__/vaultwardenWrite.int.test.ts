import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bwAvailable, startBw, type BwCli } from '../../../testing/bwCli'
import {
  addMember,
  createOrgCipher,
  putRawCipher,
  rawCipher,
  registerAccount,
  seedVaultwarden,
  setMemberCollections,
  type SeedAccount,
  type Seeded,
} from '../../../testing/vaultwarden'
import { createVaultClient, type VaultDiagnostic } from '../client'
import { encryptText } from '../crypto'
import { VaultError, type VaultSession } from '../types'

// 真连 Vaultwarden 的写入：Kioku 新建、修改的条目用官方 bw 命令行读回核对。
// 和 vaultwarden.int.test.ts 一样按 KIOKU_TEST_VAULTWARDEN_URL 开关，还要装着 bw 与 openssl
const base = process.env.KIOKU_TEST_VAULTWARDEN_URL?.replace(/\/+$/, '')

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof VaultError) return err.kind
    throw err
  }
  return 'ok'
}

interface BwItem {
  id: string
  type: number
  name: string
  notes: string | null
  collectionIds: string[]
  secureNote?: { type: number } | null
  fields?: { name: string; value: string; type: number }[] | null
  passwordHistory?: { password: string; lastUsedDate: string }[] | null
  login?: {
    username: string | null
    password: string | null
    uris?: { uri: string; match: number | null }[]
    fido2Credentials?: { rpId: string; userName: string; credentialId: string }[]
  } | null
}

type Raw = Record<string, unknown> & {
  revisionDate: string
  key: string | null
  login: Record<string, unknown> & { fido2Credentials?: unknown }
  fields: { name: string; value: string; type: number }[] | null
  passwordHistory: { password: string; lastUsedDate: string }[] | null
}

describe.skipIf(!base || !bwAvailable())('Vaultwarden 写入', () => {
  const url = base!
  let seed: Seeded
  let bw: BwCli
  let writer: VaultSession
  const client = createVaultClient()

  const sessionFor = async (
    account: SeedAccount,
    log?: (diagnostic: VaultDiagnostic) => void,
    now?: () => number,
  ): Promise<VaultSession> => {
    const c =
      log || now ? createVaultClient({ ...(log ? { log } : {}), ...(now ? { now } : {}) }) : client
    const result = await c.login({
      serverUrl: url,
      email: account.email,
      masterPassword: account.password,
      deviceId: randomUUID(),
    })
    if (result.kind !== 'ok') throw new Error('登录失败')
    return c.session({ serverUrl: url, deviceId: randomUUID(), secrets: result.secrets })
  }

  const bwGet = async (id: string): Promise<BwItem> => {
    await bw.run(['sync'])
    return JSON.parse(await bw.run(['get', 'item', id])) as BwItem
  }

  const raw = async (id: string) => (await rawCipher(url, seed.member, id)) as Raw

  const newLogin = (values: Record<string, string>, uris?: { uri: string; autofill: boolean }[]) =>
    writer.createItem({
      organizationId: seed.org.id,
      collectionId: seed.agentCollection,
      type: 'login',
      name: `kioku ${randomUUID().slice(0, 8)}`,
      values,
      ...(uris ? { uris } : {}),
    })

  beforeAll(async () => {
    seed = await seedVaultwarden(url)
    writer = await sessionFor(seed.writer)
    bw = await startBw(url)
    await bw.login(seed.member.email, seed.member.password)
  }, 120_000)

  afterAll(async () => {
    await bw?.close()
  })

  it('新建登录条目：用户名、密码与两个网址（主机加端口、不匹配），bw 读得出', async () => {
    const values = { 'login.username': 'agent', 'login.password': randomUUID() }
    const created = await newLogin(values, [
      { uri: 'https://files.example.com:8443/login', autofill: true },
      { uri: 'https://api.example.com', autofill: false },
    ])
    expect(created.values).toEqual(values)
    expect(created.collectionIds).toEqual([seed.agentCollection])
    expect(created.type).toBe('login')
    const stored = await raw(created.id)
    expect(created.revisionDate).toBe(stored.revisionDate)
    // 新条目不带条目密钥
    expect(stored.key).toBeNull()

    const item = await bwGet(created.id)
    expect(item.name).toBe(created.name)
    expect(item.type).toBe(1)
    expect(item.collectionIds).toEqual([seed.agentCollection])
    expect(item.login).toMatchObject({ username: 'agent', password: values['login.password'] })
    expect(item.login!.uris).toEqual([
      expect.objectContaining({ uri: 'https://files.example.com:8443/login', match: 1 }),
      expect.objectContaining({ uri: 'https://api.example.com', match: 5 }),
    ])
    // 读回来的就是现在的
    expect((await writer.item(created.id)).values).toEqual(values)
  }, 60_000)

  it('新建笔记：自定义字段是隐藏字段', async () => {
    const token = randomUUID()
    const created = await writer.createItem({
      organizationId: seed.org.id,
      collectionId: seed.agentCollection,
      type: 'note',
      name: 'kioku token',
      values: { notes: '令牌说明', 'field:token': token },
    })
    expect(created.values).toEqual({ notes: '令牌说明', 'field:token': token })
    const item = await bwGet(created.id)
    expect(item.type).toBe(2)
    expect(item.secureNote).toEqual({ type: 0 })
    expect(item.notes).toBe('令牌说明')
    expect(item.fields).toEqual([expect.objectContaining({ name: 'token', value: token, type: 1 })])
  }, 60_000)

  it('Vaultwarden 只限备注：4KB 的私钥与长令牌写得进去，bw 读得出；备注超长报 value_too_long', async () => {
    const privateKey = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(4096)}\n-----END PRIVATE KEY-----`
    const token = 'j'.repeat(6000)
    const created = await writer.createItem({
      organizationId: seed.org.id,
      collectionId: seed.agentCollection,
      type: 'note',
      name: 'long values',
      values: { 'field:private key': privateKey, 'field:token': token },
    })
    const item = await bwGet(created.id)
    expect(new Map(item.fields!.map((f) => [f.name, f.value]))).toEqual(
      new Map([
        ['private key', privateKey],
        ['token', token],
      ]),
    )
    expect(
      await kindOf(
        writer.updateItem(
          created.id,
          { values: { notes: 'n'.repeat(8000) } },
          created.revisionDate,
        ),
      ),
    ).toBe('value_too_long')
  }, 60_000)

  it('改密码：bw 读回新密码，旧密码进密码历史（新的在前）', async () => {
    const first = randomUUID()
    const created = await newLogin({ 'login.username': 'agent', 'login.password': first })
    const second = randomUUID()
    const { item: updated } = await writer.updateItem(
      created.id,
      { values: { 'login.password': second } },
      created.revisionDate,
    )
    expect(updated.values).toEqual({ 'login.username': 'agent', 'login.password': second })
    expect(updated.revisionDate).toBe((await raw(created.id)).revisionDate)
    expect(updated.revisionDate).not.toBe(created.revisionDate)
    expect(updated.collectionIds).toEqual([seed.agentCollection])

    const third = randomUUID()
    await writer.updateItem(
      created.id,
      { values: { 'login.password': third } },
      updated.revisionDate,
    )
    const item = await bwGet(created.id)
    expect(item.login!.password).toBe(third)
    expect(item.passwordHistory!.map((h) => h.password)).toEqual([second, first])
    expect(item.passwordHistory!.every((h) => !Number.isNaN(Date.parse(h.lastUsedDate)))).toBe(true)
  }, 60_000)

  it('修改只换给了的字段：通行密钥、别的自定义字段、密码历史原样留着', async () => {
    const id = await createOrgCipher(url, seed.member, seed.org, [seed.agentCollection], {
      type: 'login',
      login: {
        name: 'with passkey',
        username: 'agent',
        password: 'old-password',
        fields: [
          { name: 'region', value: 'cn-north' },
          { name: 'api token', value: 'old-token', type: 1 },
        ],
      },
    })
    // bw 建不了通行密钥：直接经接口写一份，用组织密钥加密
    const e = (v: string) => encryptText(v, seed.org.key)
    const before = await raw(id)
    before.login.fido2Credentials = [
      {
        credentialId: e(randomUUID()),
        keyType: e('public-key'),
        keyAlgorithm: e('ECDSA'),
        keyCurve: e('prime256v1'),
        keyValue: e('MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg'),
        rpId: e('example.com'),
        userHandle: e('dXNlcg'),
        userName: e('agent@example.com'),
        counter: e('0'),
        rpName: e('Example'),
        userDisplayName: e('agent'),
        discoverable: e('true'),
        creationDate: new Date().toISOString(),
      },
    ]
    await putRawCipher(url, seed.member, id, before)
    const stored = await raw(id)

    const item = await writer.item(id)
    const { item: updated } = await writer.updateItem(
      id,
      { values: { 'login.password': 'new-password', 'field:api token': 'new-token' } },
      item.revisionDate,
    )
    expect(updated.values).toMatchObject({
      'login.password': 'new-password',
      'field:api token': 'new-token',
      'field:region': 'cn-north',
    })
    const after = await raw(id)
    expect(after.login.fido2Credentials).toEqual(stored.login.fido2Credentials)
    expect(after.login.username).toBe(stored.login.username)
    expect(after.name).toBe(stored.name)
    expect(after.fields![0]).toEqual(stored.fields![0])
    expect(after.fields![1]!.name).toBe(stored.fields![1]!.name)
    expect(after.fields![1]!.value).not.toBe(stored.fields![1]!.value)
    // 旧密码原来的密文搬进历史
    expect(after.passwordHistory!.at(-1)!.password).toBe(stored.login.password)

    const read = await bwGet(id)
    expect(read.login!.password).toBe('new-password')
    expect(read.login!.fido2Credentials).toEqual([
      expect.objectContaining({ rpId: 'example.com', userName: 'agent@example.com' }),
    ])
    // 改了隐藏字段也照官方客户端记进历史
    expect(read.passwordHistory!.map((h) => h.password)).toEqual([
      'api token: old-token',
      'old-password',
    ])
  }, 60_000)

  it('读到之后别处改过：报 item_conflict，不覆盖', async () => {
    const created = await newLogin({ 'login.username': 'agent', 'login.password': 'kioku-1' })
    const read = await writer.item(created.id)
    const item = await bwGet(created.id)
    item.login!.password = 'from-bw'
    await bw.run(['edit', 'item', created.id, Buffer.from(JSON.stringify(item)).toString('base64')])

    expect(
      await kindOf(
        writer.updateItem(
          created.id,
          { values: { 'login.password': 'kioku-2' } },
          read.revisionDate,
        ),
      ),
    ).toBe('item_conflict')
    expect((await bwGet(created.id)).login!.password).toBe('from-bw')
  }, 60_000)

  it('只读的集合：新建与修改都报 read_only，不留下条目', async () => {
    const logs: VaultDiagnostic[] = []
    const viewer = await sessionFor(seed.dedicated, (d) => logs.push(d))
    const before = (await viewer.snapshot()).items.length
    expect(
      await kindOf(
        viewer.createItem({
          organizationId: seed.org.id,
          collectionId: seed.agentCollection,
          type: 'login',
          name: 'should not exist',
          values: { 'login.password': 'x' },
        }),
      ),
    ).toBe('read_only')
    const login = await viewer.item(seed.items.login)
    expect(
      await kindOf(
        viewer.updateItem(seed.items.login, { values: { notes: 'x' } }, login.revisionDate),
      ),
    ).toBe('read_only')
    // 在发请求之前就拦下了，不是服务端拒绝的
    expect(logs).toEqual([])
    expect((await viewer.snapshot()).items).toHaveLength(before)
    expect((await viewer.item(seed.items.login)).values).toEqual(seed.values.login)
  }, 60_000)

  it('会话缓存的集合权限过时：服务端拒绝新建，映射成 read_only，不留下条目', async () => {
    const account = await registerAccount(url, `stale-${randomUUID().slice(0, 8)}@example.com`, {
      kind: 'pbkdf2',
      iterations: 600_000,
    })
    await addMember(url, seed.member, seed.org, account, 2, [seed.agentCollection], {
      readOnly: false,
    })
    const logs: VaultDiagnostic[] = []
    const session = await sessionFor(account, (d) => logs.push(d))
    const snapshot = await session.snapshot()
    expect(snapshot.collections).toEqual([expect.objectContaining({ readOnly: false })])
    const count = snapshot.items.length
    await setMemberCollections(url, seed.member, seed.org, account, [seed.agentCollection], true)

    expect(
      await kindOf(
        session.createItem({
          organizationId: seed.org.id,
          collectionId: seed.agentCollection,
          type: 'note',
          name: 'should not exist',
          values: { notes: 'x' },
        }),
      ),
    ).toBe('read_only')
    // 是服务端拒绝的：缓存里的集合还是可以编辑
    expect(logs).toEqual([
      { what: 'rejected', status: 400, endpoint: 'cipher_create', problem: 'read_only' },
    ])
    const login = await session.item(seed.items.login)
    expect(
      await kindOf(
        session.updateItem(seed.items.login, { values: { notes: 'x' } }, login.revisionDate),
      ),
    ).toBe('read_only')
    const fresh = await sessionFor(account)
    expect((await fresh.snapshot()).items).toHaveLength(count)
  }, 60_000)

  it('同一账号一个集合可以编辑、一个只能查看；改成可以编辑之后，不等令牌刷新就能写', async () => {
    const account = await registerAccount(url, `mixed-${randomUUID().slice(0, 8)}@example.com`, {
      kind: 'pbkdf2',
      iterations: 600_000,
    })
    const { agentCollection: agent, otherCollection: other } = seed
    await addMember(url, seed.member, seed.org, account, 2, [agent, other], { writable: [agent] })
    const logs: VaultDiagnostic[] = []
    let offset = 0
    const session = await sessionFor(
      account,
      (d) => logs.push(d),
      () => Date.now() + offset,
    )
    const snapshot = await session.snapshot()
    expect(new Map(snapshot.collections.map((c) => [c.id, c.readOnly]))).toEqual(
      new Map([
        [agent, false],
        [other, true],
      ]),
    )
    const note = (collectionId: string) =>
      session.createItem({
        organizationId: seed.org.id,
        collectionId,
        type: 'note',
        name: 'mixed',
        values: { notes: 'x' },
      })
    expect((await note(agent)).collectionIds).toEqual([agent])
    expect(await kindOf(note(other))).toBe('read_only')
    const hidden = await session.item(seed.items.hidden)
    expect(hidden.collectionIds).toEqual([other])
    expect(
      await kindOf(session.updateItem(hidden.id, { values: { notes: 'x' } }, hidden.revisionDate)),
    ).toBe('read_only')
    // 都是发请求之前拦下的
    expect(logs).toEqual([])

    await setMemberCollections(url, seed.member, seed.org, account, [agent, other], false)
    // 同一个会话，缓存里 Private 还是只读：修改以刚取到的 edit 为准，新建先重新同步
    const { item: updated } = await session.updateItem(
      hidden.id,
      { values: { notes: 'now writable' } },
      hidden.revisionDate,
    )
    expect(updated.values.notes).toBe('now writable')
    expect((await bwGet(hidden.id)).notes).toBe('now writable')
    // 新建：上次同步不到 60 秒时照缓存按只读报，过了才重新同步
    expect(await kindOf(note(other))).toBe('read_only')
    offset = 61_000
    expect((await note(other)).collectionIds).toEqual([other])
    expect(logs).toEqual([])
  }, 90_000)

  it('有条目密钥的条目：用条目密钥加密，bw 读回正确', async () => {
    const id = seed.items.itemKey
    const stored = await raw(id)
    expect(stored.key).toBeTruthy()
    const item = await writer.item(id)
    const password = randomUUID()
    const { item: updated } = await writer.updateItem(
      id,
      { name: 'item key renamed', values: { 'login.password': password, 'field:extra': 'v' } },
      item.revisionDate,
    )
    expect(updated.name).toBe('item key renamed')
    expect(updated.values).toEqual({
      ...seed.values.itemKey,
      'login.password': password,
      'field:extra': 'v',
    })
    expect((await raw(id)).key).toBe(stored.key)
    const read = await bwGet(id)
    expect(read.name).toBe('item key renamed')
    expect(read.login!.password).toBe(password)
    expect(read.fields).toEqual([expect.objectContaining({ name: 'extra', value: 'v', type: 1 })])
    expect(read.passwordHistory!.map((h) => h.password)).toEqual([
      seed.values.itemKey['login.password'],
    ])
  }, 60_000)
})
