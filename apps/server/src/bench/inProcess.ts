import { randomBytes } from 'node:crypto'

import {
  LifecycleEvent,
  RecallRequest,
  type BenchRunRequest,
  type BenchRunResult,
  type BenchStep,
  type BenchTool,
} from '@kioku/contracts'

import { defaultSession } from '../access/session'
import { credentialServiceForKey } from '../credential/context'
import { logInternalError } from '../db/client'
import type { Deps, KeyPrincipal } from '../http/env'
import { firstIssue } from '../http/openapi'
import { lifecycleEvent, recallRequest, whoamiOf, type ScopeFor } from '../lifecycle/handlers'
import { PROMPT_SEMANTIC_TIMEOUT_MS } from '../lifecycle/lifecycle'
import { handleMcpRequest } from '../mcp/server'
import { memoryServiceForKey, recallScopeForKey } from '../memory/context'
import { MemoryError } from '../memory/service'
import { changeTracker } from './changes'
import {
  restFailure,
  restSuccess,
  toolOutcome,
  type BenchExecutor,
  type ResolvedStep,
  type StepOutcome,
  type ToolResult,
} from './executor'
import {
  benchLimits,
  inRollback,
  prepareQueryVectors,
  type BenchQuery,
  type RollbackRun,
} from './rollback'
import { declaredCaptures, expand, referencedVars, runSteps } from './runner'

// 进程内执行：工具走真实的 MCP 服务端，生命周期事件与 /recall 走和路由共用的处理函数。
// 两种模式都不记召回事件、不更新 Key 的最后使用时间（不经过鉴权中间件），都打码

let rpcId = 0
const mcpRequest = (method: string, params: unknown) =>
  new Request('http://bench.invalid/v1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })

// 真实的 tools/list
export async function benchTools(deps: Deps, key: KeyPrincipal): Promise<BenchTool[]> {
  const res = await handleMcpRequest(
    memoryServiceForKey(deps, key),
    recallScopeForKey(deps, key),
    credentialServiceForKey(deps, key),
    mcpRequest('tools/list', {}),
  )
  return ((await res.json()) as { result: { tools: BenchTool[] } }).result.tools
}

export interface InProcessOptions {
  run: string
  // 操作的账号，真实模式写下的事件带着它
  account: string
  // 回滚模式下的运行状态；真实模式为 null
  rollback: RollbackRun | null
}

// deps 由调用方给：回滚模式下是指向事务的那一份
export function inProcessExecutor(
  deps: Deps,
  key: KeyPrincipal,
  { run, account, rollback }: InProcessOptions,
): BenchExecutor {
  const eventContext = { bench: { account, run } }
  // 工具步骤和真实的 /v1/mcp 一样不带会话上下文，按 Key 的全部权限读写
  const session = defaultSession(key)
  const memory = memoryServiceForKey(deps, key, session, { maskSecret: true, eventContext })
  const credentials = credentialServiceForKey(deps, key, session, {
    mask: rollback ? 'all' : 'hosted',
    eventContext,
  })
  const scopeFor: ScopeFor = (s) => ({ ...recallScopeForKey(deps, key, s), record: () => {} })
  const tracker = changeTracker(
    deps,
    key,
    memory,
    rollback
      ? { kind: 'transaction' }
      : // 只用来缩小扫描范围，留点余量，应用和数据库的时钟可能差一点
        { kind: 'marked', run, since: new Date(Date.now() - 5 * 60_000) },
  )

  const callTool = async (tool: string, args: unknown): Promise<StepOutcome> => {
    const res = await handleMcpRequest(
      memory,
      scopeFor(session),
      credentials,
      mcpRequest('tools/call', { name: tool, arguments: args }),
    )
    const body = (await res.json()) as { result?: ToolResult; error?: { message?: string } }
    return body.result
      ? toolOutcome(tool, body.result)
      : restFailure(res.status >= 400 ? res.status : 500, body.error?.message ?? '')
  }

  // 和路由一样：请求体不合法回 400，业务错误带着自己的状态码，其余错误不把内部信息透给调用方
  const rest = async (
    kind: ResolvedStep['kind'],
    handler: () => Promise<unknown>,
  ): Promise<StepOutcome> => {
    try {
      // 过一遍 JSON：和接入方收到的一样，Symbol 键上的记忆 id 带不出去
      return restSuccess(kind, JSON.parse(JSON.stringify(await handler())))
    } catch (err) {
      if (err instanceof MemoryError) return restFailure(err.status, err.message)
      rollback?.note(err)
      logInternalError('测试台的步骤内部错误', err)
      return restFailure(500, '服务内部错误')
    }
  }

  const call = (step: ResolvedStep): Promise<StepOutcome> => {
    switch (step.kind) {
      case 'tool':
        return callTool(step.tool, step.arguments)
      case 'lifecycle': {
        const input = LifecycleEvent.safeParse(step.body)
        if (!input.success) return Promise.resolve(restFailure(400, firstIssue(input.error)))
        return rest('lifecycle', () => lifecycleEvent(deps, key, input.data, scopeFor))
      }
      case 'recall': {
        const input = RecallRequest.safeParse(step.body)
        if (!input.success) return Promise.resolve(restFailure(400, firstIssue(input.error)))
        return rest('recall', () => recallRequest(deps, key, input.data, scopeFor))
      }
      case 'boot':
        return rest('boot', () => scopeFor(session).boot())
      case 'whoami':
        return rest('whoami', async () => whoamiOf(key))
    }
  }

  return {
    whoami: async () => whoamiOf(key),
    async execute(step, options) {
      const outcome = await call(step)
      // 这一步记下的都取走：被吞掉的错误（例如对象直连读取失败）不能算到下一步头上
      const detail = rollback?.takeDetail() ?? null
      // 重放的结果不返回：列改动是白跑查询，还拉长持锁的时间
      const changes = options?.replaying ? null : await tracker.collect(step)
      // 列改动时记下的（等锁超时、到了总时长）不是这一步的原因，也不留到下一步
      rollback?.takeDetail()
      return {
        ...outcome,
        internalDetail: outcome.internalError ? detail : null,
        vectorSkipped: rollback?.takeVectorMissed() ?? false,
        changes,
      }
    },
    // 列一次改动、结果不要，水位就推到了现在。步骤 whoami 只是占位：只有 turn.end 才看这一步的内容
    async replayDone() {
      await tracker.collect({ kind: 'whoami' })
      rollback?.takeDetail()
    },
    stopReason: async () => (rollback ? rollback.stopReason() : null),
  }
}

// 步骤里字面量的查询，开事务之前算好向量（重放的写步骤不需要）。依赖 capture 的运行时才知道，事务里查不到，
// 这一步只走全文与关键词并标明。上限和真实路径一样：每轮输入只等一小会儿，别的只受总预算限制
export function literalQueries(steps: readonly BenchStep[], run: string): BenchQuery[] {
  const vars = new Map([['run', run]])
  const captures = declaredCaptures(steps)
  const queries: BenchQuery[] = []
  const add = (text: unknown, timeoutMs?: number) => {
    if (typeof text !== 'string' || referencedVars(text).some((name) => captures.has(name))) return
    const expanded = expand(text, vars) as string
    queries.push(timeoutMs === undefined ? { text: expanded } : { text: expanded, timeoutMs })
  }
  for (const step of steps) {
    if (step.kind === 'tool' && step.tool === 'kioku_search') add(step.arguments.query)
    if (step.kind === 'recall') add((step.body as { query?: unknown } | null)?.query)
    if (step.kind === 'lifecycle') {
      const body = step.body as { event?: unknown; prompt?: unknown } | null
      if (body?.event === 'prompt.submit') add(body.prompt, PROMPT_SEMANTIC_TIMEOUT_MS)
    }
  }
  return queries
}

const newRunMark = () => randomBytes(4).toString('hex')

export async function runBench(
  deps: Deps,
  key: KeyPrincipal,
  account: string,
  request: BenchRunRequest,
): Promise<BenchRunResult> {
  const run = newRunMark()
  const input = { mode: request.mode, steps: request.steps, replay: request.replay, run }
  if (request.mode === 'real') {
    return runSteps(inProcessExecutor(deps, key, { run, account, rollback: null }), input)
  }
  // 外部请求不进事务：事务开着时前面步骤的行锁和 URI 咨询锁都没放
  const vectors = await prepareQueryVectors(
    deps,
    literalQueries(request.steps, run),
    benchLimits(deps).embedBudgetMs,
  )
  return inRollback(deps, vectors, (scoped, rollback) =>
    runSteps(inProcessExecutor(scoped, key, { run, account, rollback }), input),
  )
}
