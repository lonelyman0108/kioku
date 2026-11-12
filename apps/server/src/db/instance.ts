// 实例里有几个账号与空间：「这个库初始化过没有」只按这一份判断，初始化页的数据库检查（db/probe.ts）
// 与恢复备份（backup/restore.ts）共用。要求 Kioku 的表已经建好：迁移在一个事务里执行，不会只建了一半
export interface InstanceContent {
  accounts: number
  spaces: number
}

// 一条语句数完。空间不在行级安全的表里，不设空间也数得到
const COUNT_CONTENT = `select (select count(*) from public.accounts)::int as accounts,
  (select count(*) from public.spaces)::int as spaces`

// 语句由调用方执行：检查用 postgres.js 的只读事务，恢复用 drizzle 的连接或事务
export async function instanceContent(
  run: (query: string) => Promise<readonly unknown[]>,
): Promise<InstanceContent> {
  const [row] = (await run(COUNT_CONTENT)) as Partial<InstanceContent>[]
  return { accounts: row?.accounts ?? 0, spaces: row?.spaces ?? 0 }
}

// 有账号或空间就算初始化过
export const isInitialized = (content: InstanceContent) =>
  content.accounts > 0 || content.spaces > 0
