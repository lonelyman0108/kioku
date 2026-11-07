import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { bwAvailable, startBw, type BwCli } from '../../../testing/bwCli'
import { nextTotp, seedVaultwarden, type Seeded } from '../../../testing/vaultwarden'
import { createVaultClient, totpCode } from '../client'
import { VaultError, type VaultLoginInput, type VaultSecrets } from '../types'

// 真连 Vaultwarden：设 KIOKU_TEST_VAULTWARDEN_URL（例如 http://127.0.0.1:18081，起法见 docker-compose.dev.yml），
// 没设就跳过，CI 里不设也不算失败。每次在实例上造一套新账号，同一个实例可以反复跑。
// 装了 bw 命令行与 openssl 时再用 bw 双向核对：bw 读得出这里写的，这里读得出 bw 写的
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

describe.skipIf(!base)('Vaultwarden', () => {
  const url = base!
  let seed: Seeded
  const client = createVaultClient()
  const input = (a: { email: string; password: string }): VaultLoginInput => ({
    serverUrl: url,
    email: a.email,
    masterPassword: a.password,
    deviceId: randomUUID(),
  })
  const login = async (a: { email: string; password: string }): Promise<VaultSecrets> => {
    const result = await client.login(input(a))
    if (result.kind !== 'ok') throw new Error('登录失败')
    return result.secrets
  }

  beforeAll(async () => {
    seed = await seedVaultwarden(url)
  }, 60_000)

  it('专用账号（PBKDF2）：只看得到分给它的集合，个人条目只计数', async () => {
    const result = await client.login(input(seed.dedicated))
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.account).toEqual({ userId: seed.dedicated.userId, email: seed.dedicated.email })
    const onSynced = vi.fn(async () => {})
    const session = client.session({
      serverUrl: url,
      deviceId: randomUUID(),
      secrets: result.secrets,
      onSynced,
    })
    const snapshot = await session.snapshot()
    expect(onSynced).toHaveBeenCalledTimes(1)
    expect(snapshot.organizations).toEqual([
      expect.objectContaining({ id: seed.org.id, role: 'user' }),
    ])
    expect(snapshot.collections.map((c) => c.name)).toEqual(['Agent'])
    expect(snapshot.personalItemCount).toBe(2)
    expect(snapshot.items.map((i) => i.id).sort()).toEqual(
      [seed.items.login, seed.items.note, seed.items.itemKey].sort(),
    )
    expect((await session.item(seed.items.login)).values).toEqual(seed.values.login)
    expect((await session.item(seed.items.note)).values).toEqual(seed.values.note)
    expect((await session.item(seed.items.itemKey)).values).toEqual(seed.values.itemKey)
    for (const id of [
      seed.items.hidden,
      seed.items.trashed,
      ...seed.items.personal,
      randomUUID(),
    ]) {
      expect(await kindOf(session.item(id))).toBe('item_unavailable')
    }
  })

  it('成员本人（Argon2id）：所有者', async () => {
    const session = client.session({
      serverUrl: url,
      deviceId: randomUUID(),
      secrets: await login(seed.member),
    })
    const snapshot = await session.snapshot()
    expect(snapshot.organizations[0]?.role).toBe('owner')
    expect(snapshot.collections.map((c) => c.name).sort()).toEqual(['Agent', 'Private'])
    expect((await session.item(seed.items.hidden)).type).toBe('login')
  })

  it('两步验证', async () => {
    expect(await client.login(input(seed.twoFactor))).toEqual({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })
    const wrong = client.login({
      ...input(seed.twoFactor),
      twoFactor: { provider: 'authenticator', code: '000000' },
    })
    expect(await kindOf(wrong)).toBe('two_factor_invalid')
    const ok = await client.login({
      ...input(seed.twoFactor),
      twoFactor: { provider: 'authenticator', code: nextTotp(seed.twoFactor.totpSecret) },
    })
    expect(ok.kind).toBe('ok')
  })

  it('主密码不对、刷新令牌无效', async () => {
    expect(await kindOf(client.login({ ...input(seed.dedicated), masterPassword: 'nope' }))).toBe(
      'invalid_credentials',
    )
    const secrets = await login(seed.dedicated)
    const session = client.session({
      serverUrl: url,
      deviceId: randomUUID(),
      secrets: { ...secrets, refreshToken: 'revoked' },
    })
    expect(await kindOf(session.snapshot())).toBe('reauth_required')
  })

  it('onSynced 抛错时调用失败', async () => {
    const refusal = new Error('拒绝')
    const session = client.session({
      serverUrl: url,
      deviceId: randomUUID(),
      secrets: await login(seed.dedicated),
      onSynced: async () => {
        throw refusal
      },
    })
    await expect(session.item(seed.items.login)).rejects.toBe(refusal)
  })

  describe.skipIf(!bwAvailable())('用 bw 命令行核对', () => {
    let bw: BwCli

    afterAll(async () => {
      await bw?.close()
    })

    it('bw 登录这里注册的账号，读出这里写的条目（含条目密钥）', async () => {
      bw = await startBw(url)
      await bw.login(seed.dedicated.email, seed.dedicated.password)
      const items = JSON.parse(await bw.run(['list', 'items'])) as {
        id: string
        organizationId?: string
        notes?: string | null
        login?: { username?: string; password?: string; totp?: string }
        fields?: { name: string; value: string }[]
      }[]
      const byId = new Map(items.map((i) => [i.id, i]))
      const flat = (id: string) => {
        const item = byId.get(id)!
        const out: Record<string, string> = {}
        if (item.login?.username) out['login.username'] = item.login.username
        if (item.login?.password) out['login.password'] = item.login.password
        if (item.login?.totp) out['login.totp'] = item.login.totp
        if (item.notes) out.notes = item.notes
        for (const f of item.fields ?? []) out[`field:${f.name}`] = f.value
        return out
      }
      expect(flat(seed.items.login)).toEqual(seed.values.login)
      expect(flat(seed.items.note)).toEqual(seed.values.note)
      expect(flat(seed.items.itemKey)).toEqual(seed.values.itemKey)
      // 个人条目 bw 也读得出：这里写的个人条目同样合规
      expect(items.filter((i) => !i.organizationId)).toHaveLength(2)
      await bw.close()
    }, 120_000)

    for (const cipherKeys of [false, true]) {
      it(`这里读得出 bw 写进组织集合的条目${cipherKeys ? '（开着条目密钥）' : ''}`, async () => {
        bw = await startBw(url, cipherKeys)
        await bw.login(seed.member.email, seed.member.password)
        const values = {
          'login.username': 'bw-user',
          'login.password': randomUUID(),
          'login.totp': 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8',
          notes: '中文备注',
          'field:secret': randomUUID(),
        }
        const item = {
          organizationId: seed.org.id,
          collectionIds: [seed.agentCollection],
          type: 1,
          name: 'bw 写的',
          notes: values.notes,
          fields: [{ type: 1, name: 'secret', value: values['field:secret'] }],
          login: {
            username: values['login.username'],
            password: values['login.password'],
            totp: values['login.totp'],
            uris: [],
          },
        }
        const created = JSON.parse(
          await bw.run(['create', 'item', Buffer.from(JSON.stringify(item)).toString('base64')]),
        ) as { id: string }
        await bw.close()

        // 条目密钥确实用上了：直接看服务端存的密文
        const raw = (await (
          await fetch(`${url}/api/ciphers/${created.id}`, {
            headers: { authorization: `Bearer ${seed.member.accessToken}` },
          })
        ).json()) as { key: string | null }
        expect(Boolean(raw.key)).toBe(cipherKeys)

        const session = client.session({
          serverUrl: url,
          deviceId: randomUUID(),
          secrets: await login(seed.dedicated),
        })
        const got = await session.item(created.id)
        expect(got.name).toBe('bw 写的')
        expect(got.values).toEqual(values)
        expect(totpCode(got.values['login.totp']!, Date.now())).toMatch(/^\d{8}$/)
        expect((await session.snapshot()).items.map((i) => i.id)).toContain(created.id)
      }, 120_000)
    }
  })
})
