import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client'
import { settings } from '../db/schema'

// 设备 Cookie：账号在某台设备上成功登录过，就给这台设备一个服务端签名的长期凭证。
// 带着它登录时可以越过「同一用户名合计」的失败上限（仍受每个客户端的上限约束），
// 所以别人从很多地址乱试密码，锁不住已经登录过的设备上的主人。思路见 OWASP 的 device cookie
export const DEVICE_COOKIE = 'kioku_device'
export const DEVICE_COOKIE_PATH = '/v1/auth'
export const DEVICE_TTL_SECONDS = 180 * 24 * 60 * 60

const SECRET_KEY = 'device_cookie_secret'
let cachedSecret: Promise<Buffer> | null = null

// 签名密钥首次使用时随机生成并存入设置表。泄露的后果只是能伪造设备 Cookie 越过合计上限，
// 不能直接登录，所以不需要额外加密
async function secret(db: Db): Promise<Buffer> {
  cachedSecret ??= (async () => {
    await db
      .insert(settings)
      .values({ key: SECRET_KEY, value: randomBytes(32).toString('base64') })
      .onConflictDoNothing()
    const [row] = await db.select().from(settings).where(eq(settings.key, SECRET_KEY))
    return Buffer.from(String(row!.value), 'base64')
  })().catch((err: unknown) => {
    cachedSecret = null
    throw err
  })
  return cachedSecret
}

export interface DeviceAccount {
  id: string
  passwordHash: string
}

// 签名里带上当前密码哈希的指纹：改了密码，之前发出的设备 Cookie 全部失效，
// 拿到过 Cookie 的人（例如曾经用泄露的密码登录过的人）不能继续越过合计上限
function sign(key: Buffer, payload: string, passwordHash: string): string {
  const fingerprint = createHash('sha256').update(passwordHash).digest('base64url')
  return createHmac('sha256', key).update(`${payload}.${fingerprint}`).digest('base64url')
}

export async function issueDeviceToken(
  db: Db,
  account: DeviceAccount,
  now = Date.now(),
): Promise<string> {
  const payload = `${account.id}.${Math.floor(now / 1000)}`
  return `${payload}.${sign(await secret(db), payload, account.passwordHash)}`
}

// 令牌是否属于这个账号且仍然有效：账号对不上、签名不对、格式不对、过期或改过密码都返回 false
export async function isTrustedDevice(
  db: Db,
  token: string | undefined,
  account: DeviceAccount | undefined,
  now = Date.now(),
): Promise<boolean> {
  const parts = token?.split('.')
  if (!account || !parts || parts.length !== 3) return false
  const [accountId, issued, signature] = parts as [string, string, string]
  const issuedAt = Number(issued)
  if (accountId !== account.id) return false
  if (!Number.isInteger(issuedAt) || now / 1000 - issuedAt > DEVICE_TTL_SECONDS) return false
  const expected = Buffer.from(
    sign(await secret(db), `${accountId}.${issued}`, account.passwordHash),
  )
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
