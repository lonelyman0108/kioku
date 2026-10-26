import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

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

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

export async function issueDeviceToken(
  db: Db,
  accountId: string,
  now = Date.now(),
): Promise<string> {
  const payload = `${accountId}.${Math.floor(now / 1000)}`
  return `${payload}.${sign(await secret(db), payload)}`
}

// 返回令牌对应的账号；签名不对、格式不对或过期都返回 null
export async function verifyDeviceToken(
  db: Db,
  token: string | undefined,
  now = Date.now(),
): Promise<string | null> {
  const parts = token?.split('.')
  if (!parts || parts.length !== 3) return null
  const [accountId, issued, signature] = parts as [string, string, string]
  const issuedAt = Number(issued)
  if (!Number.isInteger(issuedAt) || now / 1000 - issuedAt > DEVICE_TTL_SECONDS) return null
  const expected = Buffer.from(sign(await secret(db), `${accountId}.${issued}`))
  const actual = Buffer.from(signature)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? accountId : null
}
