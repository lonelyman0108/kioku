import { fileURLToPath } from 'node:url'

import { parseMasterKey } from './crypto/envelope'
import { keyIdOf, type Keyring } from './crypto/keyring'
import { resolveDatabaseUrl, type ResolvedDatabase } from './dataDir'

export interface Config {
  port: number
  // 环境变量 DATABASE_URL 优先，其次数据目录的 kioku.json；都没有时为 null，服务只提供初始化
  database: ResolvedDatabase | null
  // 数据目录：放 kioku.json
  dataDir: string
  // 设了 KIOKU_SETUP_CODE 时用它作初始化码，否则启动时随机生成
  setupCode: string | null
  migrationsFolder: string
  cookieSecure: boolean
  masterKey: Keyring | null
  trustedProxies: number
  webDir: string
}

// 迁移目录相对本文件所在目录的上一级解析：src/config.ts 与打包后的 dist/index.mjs 都在 apps/server 下一层
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // 默认是仓库里的 apps/server/.data（已在 .gitignore 里）；镜像里是 /data
  const dataDir = env.KIOKU_DATA_DIR || fileURLToPath(new URL('../.data', import.meta.url))
  return {
    port: Number(env.PORT ?? 18920),
    database: resolveDatabaseUrl(env, dataDir),
    dataDir,
    setupCode: parseSetupCode(env.KIOKU_SETUP_CODE),
    migrationsFolder:
      env.KIOKU_MIGRATIONS_DIR ?? fileURLToPath(new URL('../migrations', import.meta.url)),
    // 浏览器只在 HTTPS 或 localhost 下接受 Secure Cookie；用局域网 HTTP 地址访问时设为 false
    cookieSecure: env.KIOKU_COOKIE_SECURE !== 'false',
    // 生成：openssl rand -base64 32。丢失后已有的 secret 无法解密
    masterKey: parseMasterKeys(env.KIOKU_MASTER_KEY, env.KIOKU_MASTER_KEY_PREVIOUS),
    // 前面有几层受信任的反向代理；没有代理时保持 0，否则 X-Forwarded-For 可以伪造
    trustedProxies: parseTrustedProxies(env.KIOKU_TRUSTED_PROXIES),
    // 默认取仓库里 apps/web/dist：src/config.ts 与 dist/index.mjs 都在 apps/server 下一层
    webDir: env.KIOKU_WEB_DIR ?? fileURLToPath(new URL('../../web/dist', import.meta.url)),
  }
}

// 轮换主密钥时同时配置新旧两把：KIOKU_MASTER_KEY 是新的，KIOKU_MASTER_KEY_PREVIOUS 是旧的，
// 旧的只用来解开还没换成新密钥包装的记录，后台任务换完之后去掉它
function parseMasterKeys(
  current: string | undefined,
  previous: string | undefined,
): Keyring | null {
  if (!current) {
    if (previous) throw new Error('配置了 KIOKU_MASTER_KEY_PREVIOUS，却没有配置 KIOKU_MASTER_KEY')
    return null
  }
  const key = parseMasterKey(current)
  if (!previous) return { current: key, previous: null }
  const old = parseMasterKey(previous)
  if (keyIdOf(old) === keyIdOf(key)) {
    throw new Error('KIOKU_MASTER_KEY_PREVIOUS 和 KIOKU_MASTER_KEY 是同一把密钥')
  }
  return { current: key, previous: old }
}

function parseTrustedProxies(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > 10) {
    throw new Error('KIOKU_TRUSTED_PROXIES 应为 0 到 10 之间的整数（前面受信任的反向代理层数）')
  }
  return n
}

// 初始化码比对前的写法：去掉空白与连字符、转大写，随机生成的码按四位一组显示，照抄时带不带连字符都认
export function normalizeSetupCode(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase()
}

function parseSetupCode(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  const length = normalizeSetupCode(value).length
  if (length < 8 || length > 64) {
    throw new Error('KIOKU_SETUP_CODE 去掉空白与连字符后应为 8 到 64 个字符')
  }
  return value
}
