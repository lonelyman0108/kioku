import { fileURLToPath } from 'node:url'

export interface Config {
  port: number
  databaseUrl: string
  migrationsFolder: string
  cookieSecure: boolean
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
  }
}
