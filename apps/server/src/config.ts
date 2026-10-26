import { fileURLToPath } from 'node:url'

import { parseMasterKey } from './crypto/envelope'

export interface Config {
  port: number
  databaseUrl: string
  migrationsFolder: string
  cookieSecure: boolean
  masterKey: Buffer | null
  trustedProxies: number
}

// 迁移目录相对本文件所在目录的上一级解析：src/config.ts 与打包后的 dist/index.mjs 都在 apps/server 下一层
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('缺少环境变量 DATABASE_URL')
  return {
    port: Number(env.PORT ?? 18920),
    databaseUrl,
    migrationsFolder:
      env.KIOKU_MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations', import.meta.url)),
    // 浏览器只在 HTTPS 或 localhost 下接受 Secure Cookie；用局域网 HTTP 地址访问时设为 false
    cookieSecure: env.KIOKU_COOKIE_SECURE !== 'false',
    // 生成：openssl rand -base64 32。丢失后已有的 secret 无法解密
    masterKey: env.KIOKU_MASTER_KEY ? parseMasterKey(env.KIOKU_MASTER_KEY) : null,
    // 前面有几层受信任的反向代理；没有代理时保持 0，否则 X-Forwarded-For 可以伪造
    trustedProxies: parseTrustedProxies(env.KIOKU_TRUSTED_PROXIES),
  }
}

function parseTrustedProxies(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new Error('KIOKU_TRUSTED_PROXIES 应为 0 到 10 之间的整数（前面受信任的反向代理层数）')
  }
  return n
}
