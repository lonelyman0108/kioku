import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

// CI 里测试库在后台准备（scripts/ci/test-db.sh --background），和前面的静态检查同时进行，
// 跑测试之前在这里等它。KIOKU_TEST_DATABASE_READY 是它结束时写下的状态文件，格式见 scripts/ci/background.sh：
// 第一行是 ok 就是就绪，是 failed 时后面是日志的末尾；日志在同一目录、同名的 .log 里。没设时什么也不等

// 时限和 background.sh wait 的默认值一样
const TIMEOUT_MS = 600_000

// vitest 给 globalSetup 抛出的异常做 source map 映射时会自己报错（code.charCodeAt），真正的原因就看不到了。
// 所以异常不带调用帧，只有文字；日志另外打到标准错误
function bare(message: string): Error {
  const err = new Error(message)
  err.stack = message
  return err
}

function logTail(statusFile: string): string {
  const log = statusFile.replace(/\.status$/, '.log')
  if (log === statusFile || !existsSync(log)) return ''
  return readFileSync(log, 'utf8').trimEnd().split('\n').slice(-80).join('\n')
}

export async function waitForTestDatabase(
  file: string | undefined,
  timeoutMs = TIMEOUT_MS,
  pollMs = 1000,
  report: (text: string) => void = (text) => process.stderr.write(`${text}\n`),
): Promise<void> {
  if (!file) return
  const deadline = Date.now() + timeoutMs
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      report(logTail(file))
      throw bare(`测试数据库 ${Math.round(timeoutMs / 1000)} 秒内没有准备好，上面是它到现在的日志`)
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
