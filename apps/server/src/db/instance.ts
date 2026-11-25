// 实例里是否已有账号：初始化页数据库检查据此判断库是否已完成初始化
export interface InstanceContent {
  accounts: number
}

const COUNT_CONTENT = 'select (select count(*) from public.accounts)::int as accounts'

export async function instanceContent(
  run: (query: string) => Promise<readonly unknown[]>,
): Promise<InstanceContent> {
  const [row] = (await run(COUNT_CONTENT)) as Partial<InstanceContent>[]
  return { accounts: row?.accounts ?? 0 }
}

export const isInitialized = (content: InstanceContent) => content.accounts > 0
