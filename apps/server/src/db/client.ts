import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export interface Database {
  db: Db
  url: string
  close: () => Promise<void>
}

export function connect(url: string, options: { max?: number } = {}): Database {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} })
  const db = drizzle(client, { schema, casing: 'snake_case' })
  return { db, url, close: () => client.end() }
}

// 内容表只能在这里面访问：事务内声明当前空间，RLS 据此过滤；事务结束后设置自动失效，不会串到连接池里的下一个请求
export function withSpace<T>(db: Db, spaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.space_id', ${spaceId}, true)`)
    return fn(tx)
  })
}

// 超级用户和 BYPASSRLS 角色会绕过行级安全，空间隔离就形同虚设，所以直接拒绝启动
export async function assertRuntimeRole(db: Db): Promise<void> {
  const rows = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
    sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
  )
  const role = rows[0]
  if (!role) throw new Error('无法读取当前数据库角色')
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `数据库角色 ${role.rolname} 是超级用户或带 BYPASSRLS，会绕过空间隔离；请改用普通角色连接（见 docker/postgres/init）`,
    )
  }
}
