import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// CI 里测试库在后台准备（scripts/ci/test-db.sh --background），和前面的静态检查同时进行，
// 跑测试之前在这里等它。KIOKU_TEST_DATABASE_READY 是它结束时写下的状态文件（格式见 scripts/ci/background.sh）：
// 第一行是 ok 就是就绪，是 failed 时后面是日志的末尾。没设时什么也不等
// globalSetup 抛出的异常带着本文件的调用帧时，vitest 给它做 source map 映射会自己报错（code.charCodeAt），
// 真正的原因看不到。所以异常只带文字
function bare(message: string): Error {
  const err = new Error(message)
  err.stack = message
  return err
}

// 失败时日志末尾直接打到标准错误，不放进异常：vitest 解析异常的堆栈时会把日志里像网址的行当成调用帧，自己报错，
// 真正的原因反而看不到
export async function waitForTestDatabase(
  file: string | undefined,
  timeoutMs = 300_000,
  pollMs = 1000,
  report: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): Promise<void> {
  if (!file) return
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      throw bare(`测试数据库 ${Math.round(timeoutMs / 1000)} 秒内没有准备好（状态文件 ${file}）`)
    }
    await sleep(pollMs)
  }
  const [first, ...rest] = readFileSync(file, 'utf8').trimEnd().split('\n')
  if (first !== 'ok') {
    report(rest.join('\n'))
    throw bare('测试数据库没有起来，原因见上面的日志')
  }
}

export default async function setup(): Promise<void> {
  await waitForTestDatabase(process.env.KIOKU_TEST_DATABASE_READY)
}
