import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Keyword, Layer, MemoryUri, RecallRequest, Sensitivity } from '@kioku/contracts'
import { z } from 'zod'

import type { RecallScope } from '../lifecycle/scope'
import { GUIDANCE } from '../lifecycle/lifecycle'
import { MemoryError, type MemoryService } from '../memory/service'
import { formatBootBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import { VERSION } from '../version'
import { formatChildren, formatDomains, formatMemory } from './format'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

// 业务错误作为工具错误返回给模型，让它能据此调整；其余错误照常抛出
async function tool(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] }
  } catch (err) {
    if (err instanceof MemoryError)
      return { content: [{ type: 'text', text: err.message }], isError: true }
    throw err
  }
}

export function buildMcpServer(memory: MemoryService, scope: RecallScope): McpServer {
  const server = new McpServer({ name: 'kioku', version: VERSION })

  server.registerTool(
    'kioku_boot',
    {
      description:
        '读取启动基线：使用指引与 priority 0 的核心记忆。没有启动钩子的客户端在会话开始时调用一次。',
      annotations: { readOnlyHint: true },
    },
    () => tool(async () => formatBootBlock(await scope.boot(), GUIDANCE)),
  )

  server.registerTool(
    'kioku_search',
    {
      description: '按语义、全文和关键词搜索记忆，返回候选 URI 与线索；需要正文时再用 kioku_get。',
      inputSchema: {
        query: RecallRequest.shape.query.describe('要找的内容，用自然语言描述'),
        limit: z.number().int().min(1).max(30).optional().describe('最多返回几条，默认 10'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit }) =>
      tool(async () => {
        const candidates = await scope.recall(query, { limit: limit ?? 10, minScore: 0 })
        return formatRecallBlock(candidates) || '没有找到相关记忆'
      }),
  )

  server.registerTool(
    'kioku_get',
    {
      description: '按 URI 读取一条记忆的完整正文。召回结果只是候选，引用之前先用它读正文。',
      inputSchema: { uri: MemoryUri.describe('记忆 URI，例如 core://agent') },
      annotations: { readOnlyHint: true },
    },
    ({ uri }) => tool(async () => formatMemory(await memory.get(uri))),
  )

  server.registerTool(
    'kioku_list',
    {
      description:
        '浏览记忆树：不带参数列出所有 domain；给 domain 名或 URI 时列出它下面的直接子节点。',
      inputSchema: { of: z.string().optional().describe('domain 名（如 core）或节点 URI') },
      annotations: { readOnlyHint: true },
    },
    ({ of }) =>
      tool(async () =>
        of ? formatChildren(await memory.children(of)) : formatDomains(await memory.domains()),
      ),
  )

  server.registerTool(
    'kioku_create',
    {
      description:
        '新建一条长期记忆。正文要自带背景（为什么、在什么条件下），disclosure 写清楚什么场景下该想起它。' +
        'persona://<人格>/ 与 app://<应用>/ 下的记忆分别属于人格层和应用层；其余 domain 不指定 layer 时按私人层保存。',
      inputSchema: {
        uri: MemoryUri.describe('新记忆的 URI'),
        content: z.string().min(1).describe('正文'),
        disclosure: z.string().optional().describe('什么场景下需要想起这条记忆'),
        priority: z.number().int().min(0).max(99).optional().describe('0 最重要，默认 2'),
        glossary: z.array(Keyword).optional().describe('关键词，用于召回'),
        layer: Layer.optional().describe('层：base / owner / private 等'),
        sensitivity: Sensitivity.optional().describe(
          '敏感级：public / internal / private / secret',
        ),
      },
    },
    (args) =>
      tool(async () =>
        formatMemory(
          await memory.create({
            uri: args.uri,
            content: args.content,
            priority: args.priority ?? 2,
            glossary: args.glossary ?? [],
            ...(args.disclosure ? { disclosure: args.disclosure } : {}),
            ...(args.layer ? { layer: args.layer } : {}),
            ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
          }),
        ),
      ),
  )

  server.registerTool(
    'kioku_update',
    {
      description:
        '修改已有记忆。改之前先用 kioku_get 读正文；带上 expected_version 防止覆盖别人的修改。',
      inputSchema: {
        uri: MemoryUri,
        content: z.string().min(1).optional().describe('新的完整正文'),
        disclosure: z.string().nullable().optional(),
        priority: z.number().int().min(0).max(99).optional(),
        sensitivity: Sensitivity.optional(),
        glossary_add: z.array(Keyword).optional(),
        glossary_remove: z.array(z.string().trim().min(1).max(64)).optional(),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
      },
    },
    (args) =>
      tool(async () =>
        formatMemory(
          await memory.update({
            uri: args.uri,
            ...(args.content !== undefined ? { content: args.content } : {}),
            ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
            ...(args.priority !== undefined ? { priority: args.priority } : {}),
            ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
            ...(args.glossary_add ? { glossaryAdd: args.glossary_add } : {}),
            ...(args.glossary_remove ? { glossaryRemove: args.glossary_remove } : {}),
            ...(args.expected_version !== undefined
              ? { expectedVersion: args.expected_version }
              : {}),
          }),
        ),
      ),
  )

  server.registerTool(
    'kioku_delete',
    {
      description: '删除一条记忆。历史事件会保留，必要时可以恢复。',
      inputSchema: { uri: MemoryUri },
      annotations: { destructiveHint: true },
    },
    ({ uri }) =>
      tool(async () => {
        await memory.delete(uri)
        return `已删除 ${uri}`
      }),
  )

  server.registerTool(
    'kioku_move',
    {
      description:
        '修改记忆的 URI（改名或移到别的父节点下）。人格层与应用层的记忆只能在同一个标识下移动。',
      inputSchema: { from: MemoryUri, to: MemoryUri },
    },
    ({ from, to }) => tool(async () => formatMemory(await memory.move({ from, to }))),
  )

  return server
}

// 无状态模式：每个请求一个服务器实例，不在进程里保存会话，方便多实例部署
export async function handleMcpRequest(
  memory: MemoryService,
  scope: RecallScope,
  request: Request,
): Promise<Response> {
  const server = buildMcpServer(memory, scope)
  // 不传 sessionIdGenerator 即无状态模式
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
