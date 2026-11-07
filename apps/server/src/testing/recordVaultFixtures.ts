import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createVaultClient } from '../credential/bitwarden/client'
import { VaultError, type VaultLoginInput } from '../credential/bitwarden/types'
import { startBw } from './bwCli'
import { nextTotp, seedVaultwarden } from './vaultwarden'

// 从本地的测试 Vaultwarden 录下单元测试用的响应，写进 credential/bitwarden/__tests__/fixtures/vaultwarden.json。
// 账号与密码都是随机生成的测试数据。需要 bw 命令行与 openssl（用 bw 写两个条目，核对客户端读得出 bw 写的）。
// 用法（在 apps/server 下）：pnpm exec tsx src/testing/recordVaultFixtures.ts http://127.0.0.1:18081

export interface RecordedExchange {
  scenario: string
  method: string
  // 不含查询串
  path: string
  // 令牌请求的表单字段（grant_type、password 等），别的请求为 null
  form: Record<string, string> | null
  status: number
  body: unknown
}

const OUT = fileURLToPath(
  new URL('../credential/bitwarden/__tests__/fixtures/vaultwarden.json', import.meta.url),
)

async function main(base: string): Promise<void> {
  const seed = await seedVaultwarden(base)

  // bw 写两个条目：普通的，和开着条目密钥写的
  const bwItems: Record<string, { id: string; values: Record<string, string> }> = {}
  for (const [label, cipherKeys] of [
    ['bw', false],
    ['bwItemKey', true],
  ] as const) {
    const bw = await startBw(base, cipherKeys)
    try {
      await bw.login(seed.member.email, seed.member.password)
      const values = {
        'login.username': `${label}-user`,
        'login.password': randomUUID(),
        'login.totp': 'JBSWY3DPEHPK3PXP',
        notes: `written by bw (${label})`,
        'field:secret': randomUUID(),
      }
      const item = {
        organizationId: seed.org.id,
        collectionIds: [seed.agentCollection],
        type: 1,
        name: `bw ${label}`,
        notes: values.notes,
        fields: [{ type: 1, name: 'secret', value: values['field:secret'] }],
        login: {
          username: values['login.username'],
          password: values['login.password'],
          totp: values['login.totp'],
          uris: [],
        },
      }
      const out = await bw.run([
        'create',
        'item',
        Buffer.from(JSON.stringify(item)).toString('base64'),
      ])
      bwItems[label] = { id: (JSON.parse(out) as { id: string }).id, values }
    } finally {
      await bw.close()
    }
  }

  const exchanges: RecordedExchange[] = []
  let scenario = ''
  const client = createVaultClient({
    fetch: async (input, init) => {
      const res = await fetch(input, init)
      const url = new URL(String(input))
      const text = await res.clone().text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // 保留原文
      }
      exchanges.push({
        scenario,
        method: init?.method ?? 'GET',
        path: url.pathname,
        form: url.pathname.endsWith('/connect/token')
          ? Object.fromEntries(new URLSearchParams(String(init?.body)))
          : null,
        status: res.status,
        body,
      })
      return res
    },
  })
  const expectFail = async (p: Promise<unknown>) => {
    try {
      await p
    } catch (err) {
      if (err instanceof VaultError) return
      throw err
    }
    throw new Error(`${scenario} 应当失败`)
  }

  const accounts = {
    dedicated: {
      email: seed.dedicated.email,
      password: seed.dedicated.password,
      deviceId: randomUUID(),
    },
    member: { email: seed.member.email, password: seed.member.password, deviceId: randomUUID() },
    twoFactor: {
      email: seed.twoFactor.email,
      password: seed.twoFactor.password,
      deviceId: randomUUID(),
      totpSecret: seed.twoFactor.totpSecret,
    },
  }
  const input = (a: { email: string; password: string; deviceId: string }): VaultLoginInput => ({
    serverUrl: base,
    email: a.email,
    masterPassword: a.password,
    deviceId: a.deviceId,
  })
  const missing = randomUUID()

  for (const name of ['dedicated', 'member'] as const) {
    scenario = `${name}.login`
    const result = await client.login(input(accounts[name]))
    if (result.kind !== 'ok') throw new Error(`${name} 登录失败`)
    scenario = `${name}.session`
    const session = client.session({
      serverUrl: base,
      deviceId: accounts[name].deviceId,
      secrets: result.secrets,
    })
    await session.snapshot()
    const ids = [
      seed.items.login,
      seed.items.note,
      seed.items.itemKey,
      bwItems.bw!.id,
      bwItems.bwItemKey!.id,
      seed.items.hidden,
      seed.items.trashed,
      ...seed.items.personal,
      missing,
    ]
    for (const id of ids) await session.item(id).catch(() => {})
  }

  scenario = 'twoFactor.required'
  await client.login(input(accounts.twoFactor))
  scenario = 'twoFactor.invalid'
  await expectFail(
    client.login({
      ...input(accounts.twoFactor),
      twoFactor: { provider: 'authenticator', code: '000000' },
    }),
  )
  scenario = 'twoFactor.ok'
  const ok = await client.login({
    ...input(accounts.twoFactor),
    twoFactor: { provider: 'authenticator', code: nextTotp(seed.twoFactor.totpSecret) },
  })
  if (ok.kind !== 'ok') throw new Error('两步验证登录失败')
  scenario = 'badPassword'
  await expectFail(
    client.login({ ...input(accounts.dedicated), masterPassword: 'not-the-password' }),
  )
  scenario = 'badRefresh'
  await expectFail(
    client
      .session({
        serverUrl: base,
        deviceId: accounts.dedicated.deviceId,
        secrets: { refreshToken: 'revoked', userKey: Buffer.alloc(64) },
      })
      .snapshot(),
  )

  const fixture = {
    server: base,
    recordedAt: new Date().toISOString(),
    accounts,
    organizationId: seed.org.id,
    collections: { agent: seed.agentCollection, other: seed.otherCollection },
    items: {
      login: seed.items.login,
      note: seed.items.note,
      itemKey: seed.items.itemKey,
      bw: bwItems.bw!.id,
      bwItemKey: bwItems.bwItemKey!.id,
      hidden: seed.items.hidden,
      trashed: seed.items.trashed,
      personal: seed.items.personal,
      missing,
    },
    values: {
      login: seed.values.login,
      note: seed.values.note,
      itemKey: seed.values.itemKey,
      bw: bwItems.bw!.values,
      bwItemKey: bwItems.bwItemKey!.values,
    },
    exchanges,
  }
  // Vaultwarden 的报错文字里带请求方的地址（容器网络的网关），换成 127.0.0.1，仓库里不留内网地址
  const text = JSON.stringify(fixture, null, 2).replace(
    /\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/g,
    '127.0.0.1',
  )
  writeFileSync(OUT, `${text}\n`)
  // 按仓库的格式写，format:check 才过
  execFileSync('pnpm', ['exec', 'prettier', '--write', OUT], { stdio: 'ignore' })
  process.stdout.write(`已写入 ${OUT}，${exchanges.length} 个响应\n`)
}

const base = process.argv[2]
if (!base) {
  process.stderr.write('用法：tsx src/testing/recordVaultFixtures.ts <Vaultwarden 地址>\n')
  process.exit(2)
}
await main(base.replace(/\/+$/, ''))
