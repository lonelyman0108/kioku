// 集成测试的并行数：KIOKU_TEST_DATABASE_WORKERS。集成测试会清空整个库，同一个库上的测试文件只能串行；
// 设成 N（大于 1）时测试文件按 N 个 worker 并行，每个 worker 连自己的库（库名后加 _w<编号>）。
// 这些库要事先由超级用户建好：应用角色没有建库权限。CI 里由 scripts/ci/test-db.sh 建
export const testWorkers = (): number => parseWorkers(process.env.KIOKU_TEST_DATABASE_WORKERS)

export function parseWorkers(value: string | undefined): number {
  if (value === undefined || value === '') return 1
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`KIOKU_TEST_DATABASE_WORKERS 要是正整数，现在是「${value}」`)
  }
  return n
}

// 这个 worker 连哪个库。vitest 给每个 worker 的编号从 1 到 maxWorkers（VITEST_POOL_ID），同一时刻不重复
export function workerDatabaseUrl(
  url: string,
  workers: number,
  poolId: string | undefined,
): string {
  if (workers <= 1) return url
  const id = Number(poolId)
  if (!Number.isInteger(id) || id < 1 || id > workers) {
    throw new Error(`worker 编号「${poolId ?? ''}」不在 1 到 ${workers} 之间，找不到对应的测试库`)
  }
  const u = new URL(url)
  if (u.pathname.length <= 1) throw new Error('KIOKU_TEST_DATABASE_URL 里没有库名')
  u.pathname = `${u.pathname}_w${id}`
  return u.toString()
}
