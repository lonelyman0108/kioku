import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  BenchScenario,
  mayWrite,
  type BenchRunResult,
  type BenchStep,
  type BenchStepResult,
} from '@kioku/contracts'

import { handshakeProblem, httpExecutor } from '../bench/httpExecutor'
import { runSteps } from '../bench/runner'
import { BENCH_SCENARIOS, scenariosForRuntime } from '../bench/scenarios'
import { runCli, UsageError } from './common'

const HELP = `用真实 HTTP 与真实 Key 跑测试台的场景，覆盖鉴权与网络这一层。退出码表示是否全部通过。

用法：KIOKU_BENCH_KEY=<Key> node dist/bench.mjs --url <服务地址> [选项]

不指定场景时跑这把 Key 的应用的运行时类型适用的全部内置预设。

  --url <地址>        服务地址，也可以用环境变量 KIOKU_BENCH_URL
  --scenario <id>     跑这个内置预设，可以写多次
  --file <文件>       跑这个 JSON 文件里的场景，可以写多次
  --list              列出内置预设，不连服务
  --allow-writes      允许写操作。这里没有回滚：写工具真的写入；kioku_credential 取值记访问事件；
                      turn.end 进对话缓冲、会排抽取；带私聊、群聊、频道上下文的生命周期事件与 /recall，
                      第一次见到的平台账号会新建对象，对象没有删除接口，只能合并。
                      kioku_get 读到引用外部凭据的记忆时也记访问事件，不算写操作。
                      event、chatType 写成变量时运行前判不出来：展开之后才看出要写的步骤不发请求，算失败
  --show-output       打印每一步收到的原文。可能含明文：这里没有打码，取值是一次真实调用
  -h, --help          显示帮助

默认只输出步骤名、通过与否和失败的断言。不满足 requires 的步骤记「跳过」，不算失败。
只列结果的场景（权限探测）不判通过与失败：每把 Key 的正确结果都不同，每步显示成功或报错（REST 带状态码），
不带正文；内部错误仍算失败。

环境变量：
  KIOKU_BENCH_KEY     API Key，不走命令行参数（参数会进 shell 历史与进程列表）
  KIOKU_BENCH_URL     服务地址

退出码：0 没有失败的步骤；1 有失败或没有执行的步骤，或连不上服务；2 用法错误、运行前看得出要写却没有 --allow-writes`

const STATUS: Record<BenchStepResult['status'], string> = {
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
  notRun: '没有执行',
}

async function loadScenario(path: string): Promise<BenchScenario> {
  const text = await readFile(path, 'utf8').catch((err: Error) => {
    throw new UsageError(`读不了场景文件 ${path}：${err.message}`)
  })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new UsageError(`场景文件 ${path} 不是合法的 JSON`)
  }
  const parsed = BenchScenario.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new UsageError(
      `场景文件 ${path} 的格式不对：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`,
    )
  }
  return parsed.data
}

// 只列结果的场景里没出问题的步骤：只说成功还是报错，不算通过。工具步骤没有状态码
const probeOutcome = (step: BenchStepResult) =>
  !step.isError ? '成功' : step.httpStatus === null ? '报错' : `报错 ${step.httpStatus}`

function printResult(scenario: BenchScenario, result: BenchRunResult, showOutput: boolean): void {
  console.log(`\n${scenario.title}（${scenario.id}）`)
  // 内部错误与不成立的断言仍是失败，只有通过的步骤换成结果
  const listed = (step: BenchStepResult) => scenario.probe === true && step.status === 'passed'
  for (const step of result.steps) {
    const shown = listed(step) ? probeOutcome(step) : STATUS[step.status]
    const reason = step.reason ? `：${step.reason}` : ''
    console.log(`  ${shown}  ${step.label}${reason}`)
    for (const assertion of step.assertions) {
      if (!assertion.ok) console.log(`        ${assertion.message}`)
    }
    if (showOutput && step.status !== 'skipped' && step.status !== 'notRun') {
      for (const line of step.text.split('\n')) console.log(`      | ${line}`)
    }
  }
  const { passed, failed, skipped, notRun } = result.counts
  const rejected = result.steps.filter((step) => listed(step) && step.isError).length
  const head = scenario.probe ? `成功 ${passed - rejected}，报错 ${rejected}` : `通过 ${passed}`
  console.log(`  ${head}，失败 ${failed}，跳过 ${skipped}，没有执行 ${notRun}`)
}

function parseOptions() {
  try {
    return parseArgs({
      options: {
        url: { type: 'string' },
        scenario: { type: 'string', multiple: true, default: [] },
        file: { type: 'string', multiple: true, default: [] },
        list: { type: 'boolean', default: false },
        'allow-writes': { type: 'boolean', default: false },
        'show-output': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

async function main(): Promise<void> {
  const values = parseOptions()
  if (values.help) {
    console.log(HELP)
    return
  }
  if (values.list) {
    for (const s of BENCH_SCENARIOS) {
      const runtimes = s.runtimes ? `（${s.runtimes.join('、')}）` : ''
      console.log(`${s.id}${runtimes}：${s.title}`)
    }
    return
  }
  const url = values.url ?? process.env.KIOKU_BENCH_URL
  if (!url) throw new UsageError('缺少服务地址：--url 或环境变量 KIOKU_BENCH_URL')
  const key = process.env.KIOKU_BENCH_KEY
  if (!key) throw new UsageError('缺少 API Key：环境变量 KIOKU_BENCH_KEY')

  const chosen = values.scenario.map((id) => {
    const found = BENCH_SCENARIOS.find((s) => s.id === id)
    if (!found) throw new UsageError(`没有这个内置预设：${id}（用 --list 查看）`)
    return found
  })
  chosen.push(...(await Promise.all(values.file.map(loadScenario))))

  const executor = httpExecutor({ url, key })
  let ok = true
  try {
    const whoami = await executor.whoami()
    const scenarios = chosen.length ? chosen : scenariosForRuntime(whoami.app.runtimeFamily)

    // 第一步之前就拒绝，不会只跑了一半
    if (!values['allow-writes']) {
      const writing = scenarios.flatMap((s) =>
        s.steps.flatMap((step, i) =>
          mayWrite(step) ? [`  ${s.id}：${step.label ?? `第 ${i + 1} 步`}`] : [],
        ),
      )
      if (writing.length) {
        throw new UsageError(
          `这些步骤可能写库，这里没有回滚，要加 --allow-writes：\n${writing.join('\n')}`,
        )
      }
    }

    const server = await executor.handshake()
    const problem = handshakeProblem(server)
    if (problem) throw new Error(problem)
    console.log(`握手：${server.name} ${server.version}，${server.tools.length} 个工具`)
    console.log(`应用：${whoami.app.name}（${whoami.app.runtimeFamily}）`)

    // 上面看的是展开之前的步骤：event、chatType 写成变量时看不出来，执行时按展开后的再判一次
    const refuse = (step: BenchStep) =>
      !values['allow-writes'] && mayWrite(step)
        ? '这一步展开变量之后可能写库，这里没有回滚，没有发请求；要加 --allow-writes'
        : null

    for (const scenario of scenarios) {
      const result = await runSteps(executor, {
        mode: 'real',
        steps: scenario.steps,
        replay: [],
        run: randomBytes(4).toString('hex'),
        refuse,
      })
      printResult(scenario, result, values['show-output'])
      ok &&= result.ok
    }
  } finally {
    await executor.close()
  }
  console.log(ok ? '\n没有失败的步骤' : '\n有失败的步骤')
  if (!ok) process.exitCode = 1
}

runCli(HELP, main)
