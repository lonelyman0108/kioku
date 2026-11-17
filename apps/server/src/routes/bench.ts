import { createRoute, z } from '@hono/zod-openapi'
import {
  BENCH_AGENT_MAX_BYTES,
  BENCH_MAX_REQUEST_BYTES,
  BenchAgentInfo,
  BenchAgentTurnRequest,
  BenchAgentTurnResult,
  BenchRunRequest,
  BenchRunResult,
  BenchScenarioList,
  BenchToolList,
  ErrorResponse,
} from '@kioku/contracts'
import { bodyLimit } from 'hono/body-limit'

import { keyToSimulate } from '../access/simulate'
import { isInstanceAdmin } from '../auth/middleware'
import { agentGetsTools, agentLoopFor, agentSendsTurnEnd } from '../bench/agentLoop'
import { AgentModelError, requestAgentTurn, toolDefinitions } from '../bench/agentModel'
import { benchTools, runBench } from '../bench/inProcess'
import { BENCH_SCENARIOS } from '../bench/scenarios'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { consoleRoleFor } from '../memory/context'
import { loadBenchAgentModelState, resolveChatProfileById } from '../models/store'
import { unlocked } from '../settings/endpoint'

const KeyParams = z.object({ spaceId: z.uuid(), appId: z.uuid(), keyId: z.uuid() })
const errors = {
  403: jsonResponse('没有权限', ErrorResponse),
  404: jsonResponse('应用或 Key 不存在，或 Key 已作废', ErrorResponse),
}

const toolsRoute = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/tools',
  tags: ['bench'],
  summary: '测试台：真实 MCP 服务端的工具列表（只给应用主人）',
  request: { params: KeyParams },
  responses: { 200: jsonResponse('工具列表', BenchToolList), ...errors },
})

const runRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/run',
  tags: ['bench'],
  summary: '测试台：按这把 Key 执行一串步骤，默认放进事务、结束时回滚（只给应用主人）',
  middleware: [
    bodyLimit({
      maxSize: BENCH_MAX_REQUEST_BYTES,
      onError: (c) => c.json({ error: '请求体过大，请减少步骤或清空重放后重试' }, 413),
    }),
  ],
  request: { params: KeyParams, body: jsonBody(BenchRunRequest) },
  responses: {
    200: jsonResponse('每一步的结果', BenchRunResult),
    400: jsonResponse('请求不合法', ErrorResponse),
    413: jsonResponse('请求体太大', ErrorResponse),
    429: jsonResponse('同时运行的回滚太多', ErrorResponse),
    ...errors,
  },
})

const scenariosRoute = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/bench/scenarios',
  tags: ['bench'],
  summary: '测试台：内置的场景预设',
  request: { params: z.object({ spaceId: z.uuid() }) },
  responses: {
    200: jsonResponse('场景', BenchScenarioList),
    403: jsonResponse('不是该空间成员', ErrorResponse),
  },
})

const agentInfoRoute = createRoute({
  method: 'get',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/agent',
  tags: ['bench'],
  summary:
    '测试台：模型代理可用状态（非实例管理员也返回原因）、可选对话模型列表、默认模型、接口地址、运行时循环与是否给工具（只给应用所有者）',
  request: { params: KeyParams },
  responses: { 200: jsonResponse('模型代理的情况', BenchAgentInfo), ...errors },
})

const agentTurnRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/apps/{appId}/keys/{keyId}/bench/agent/turn',
  tags: ['bench'],
  summary:
    '测试台：请求一次模型，使用所选对话模型或默认模型，工具来自真实 tools/list；不计入抽取预算、不写库（只给实例管理员且是应用所有者）',
  middleware: [
    bodyLimit({
      // 留出请求体里 messages 之外的部分，messages 本身的上限在契约里
      maxSize: BENCH_AGENT_MAX_BYTES + 64 * 1024,
      onError: (c) => c.json({ error: '对话过长，请清空后重试' }, 413),
    }),
  ],
  request: { params: KeyParams, body: jsonBody(BenchAgentTurnRequest) },
  responses: {
    200: jsonResponse('助手消息与解析好的工具调用', BenchAgentTurnResult),
    400: jsonResponse('请求不合法、尚未配置可用的对话模型，或保存的 Key 解不开', ErrorResponse),
    413: jsonResponse('请求体太大', ErrorResponse),
    502: jsonResponse('请求模型失败，带截断后的上游原文', ErrorResponse),
    ...errors,
  },
})

// 测试台是管理界面的接口（Cookie 会话）：tags 不用接入方的那几个，不进 Python SDK 的 OpenAPI
export function benchRoutes(deps: Deps) {
  return router()
    .openapi(toolsRoute, async (c) => {
      const found = await keyToSimulate(deps, c.req.valid('param'), c.get('console').accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json({ tools: await benchTools(deps, found.key) }, 200)
    })
    .openapi(runRoute, async (c) => {
      const accountId = c.get('console').accountId
      const found = await keyToSimulate(deps, c.req.valid('param'), accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      return c.json(await runBench(deps, found.key, accountId, c.req.valid('json')), 200)
    })
    .openapi(scenariosRoute, async (c) => {
      await consoleRoleFor(deps, c.req.valid('param').spaceId, c.get('console').accountId)
      return c.json({ scenarios: [...BENCH_SCENARIOS] }, 200)
    })
    .openapi(agentInfoRoute, async (c) => {
      const accountId = c.get('console').accountId
      const found = await keyToSimulate(deps, c.req.valid('param'), accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      const loop = agentLoopFor(found.key.app.runtimeFamily)
      const runtime = {
        loop,
        tools: agentGetsTools(loop),
        turnEnd: agentSendsTurnEnd(found.key.app.runtimeFamily),
      }
      // 先判身份、不查设置：模型配没配、配的什么都是实例设置，不给实例管理员之外的人看
      if (!(await isInstanceAdmin(deps.db, accountId))) {
        return c.json(
          {
            available: false,
            reason: 'notAdmin' as const,
            defaultProfileId: null,
            defaultModel: null,
            endpoint: null,
            models: [],
            ...runtime,
          },
          200,
        )
      }
      const state = await loadBenchAgentModelState(deps.db, deps.masterKey)
      const def = state.defaultProfileId
        ? (state.models.find((m) => m.profileId === state.defaultProfileId) ?? null)
        : null
      const anyAvailable = state.models.some((m) => m.available)
      const reason =
        state.models.length === 0
          ? ('noModel' as const)
          : !anyAvailable
            ? ('keyLocked' as const)
            : null
      return c.json(
        {
          available: anyAvailable,
          reason,
          defaultProfileId: state.defaultProfileId,
          defaultModel: def?.model ?? null,
          endpoint: def?.endpoint ?? null,
          models: state.models,
          ...runtime,
        },
        200,
      )
    })
    .openapi(agentTurnRoute, async (c) => {
      const accountId = c.get('console').accountId
      const found = await keyToSimulate(deps, c.req.valid('param'), accountId)
      if ('error' in found) return c.json({ error: found.error }, found.status)
      if (!(await isInstanceAdmin(deps.db, accountId))) {
        return c.json(
          {
            error: '仅实例管理员可使用模型代理：请求使用实例配置的模型 API Key，且不计入抽取预算',
          },
          403,
        )
      }
      const { profileId, messages } = c.req.valid('json')
      let targetId = profileId
      if (!targetId) {
        const state = await loadBenchAgentModelState(deps.db, deps.masterKey)
        if (!state.models.length) {
          return c.json({ error: '尚未配置可用的对话模型，请先在实例设置中添加模型。' }, 400)
        }
        targetId = state.defaultProfileId ?? undefined
      }
      if (!targetId) {
        return c.json({ error: '尚未配置可用的对话模型，请先在实例设置中添加模型。' }, 400)
      }
      const loaded = await unlocked(() => resolveChatProfileById(deps.db, deps.masterKey, targetId))
      if (!loaded.ok) return c.json({ error: loaded.error }, 400)
      const config = loaded.value
      if (!config) {
        return c.json({ error: '所选模型条目不存在，请重新选择后再试。' }, 400)
      }
      const tools = agentGetsTools(agentLoopFor(found.key.app.runtimeFamily))
        ? toolDefinitions(await benchTools(deps, found.key))
        : []
      // 这里没有事务：请求模型可能要一两分钟，不占连接、不持锁
      try {
        const turn = await requestAgentTurn(config, {
          messages,
          tools,
          signal: c.req.raw.signal,
        })
        return c.json(turn, 200)
      } catch (err) {
        if (err instanceof AgentModelError) return c.json({ error: err.message }, 502)
        throw err
      }
    })
}
