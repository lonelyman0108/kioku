import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  BROWSE_GROUP_BY,
  BrowseEntriesQuery,
  CreateEntryRequest,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_KINDS,
  ENTRY_TITLE_MAX,
  normalizeProjectSlug,
  SCENE_TAGS_MAX,
  TOPICS_MAX,
  UpdateEntryRequest,
} from '@kioku/contracts'
import { z } from 'zod'

import { synthesizeFocus } from '../access/scope'
import type { CredentialService } from '../credential/service'
import { logInternalError } from '../db/client'
import type { Deps, KeyPrincipal } from '../http/env'
import { GUIDANCE } from '../lifecycle/lifecycle'
import { MemoryError } from '../memory/errors'
import type { EntryService } from '../memory/service'
import { compileBoot, formatBootBlock, formatSummaryBlock } from '../recall/boot'
import { formatRecallBlock, recallEntries } from '../recall/recall'
import { VERSION } from '../version'
import {
  formatBrowseResponse,
  formatCredentialMetadataList,
  formatEntryDetail,
  TOOL_INTERNAL_ERROR,
} from './format'

type StructuredPayload = Record<string, unknown>
type ToolOutcome = string | { text: string; structuredContent: StructuredPayload }
type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: StructuredPayload
  isError?: boolean
}

async function runTool(fn: () => Promise<ToolOutcome>): Promise<ToolResult> {
  try {
    const outcome = await fn()
    if (typeof outcome === 'string') {
      return { content: [{ type: 'text', text: outcome }] }
    }
    return {
      content: [{ type: 'text', text: outcome.text }],
      structuredContent: outcome.structuredContent,
    }
  } catch (err) {
    if (err instanceof MemoryError) {
      return {
        content: [{ type: 'text', text: err.message }],
        structuredContent: {
          status: err.status,
          ...(err.code ? { code: err.code } : {}),
          error: err.message,
        },
        isError: true,
      }
    }
    logInternalError('MCP 工具内部错误', err)
    return { content: [{ type: 'text', text: TOOL_INTERNAL_ERROR }], isError: true }
  }
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
  throw new MemoryError(400, `${where}${issue?.message ?? '参数格式错误'}`)
}

// MCP inputSchema 不直接使用带 .meta({ id }) 或 .transform() 的契约对象，避免生成非法 JSON Schema
const McpTagList = z.array(z.string().min(1).max(64)).max(SCENE_TAGS_MAX)
const McpTopicList = z.array(z.string().min(1).max(64)).max(TOPICS_MAX)
const McpEntryKind = z.enum(ENTRY_KINDS)
const McpGroupBy = z.enum(BROWSE_GROUP_BY)

export function createKiokuMcpServer(
  deps: Deps,
  key: KeyPrincipal,
  entries: EntryService,
  credentials: CredentialService,
): McpServer {
  const server = new McpServer({ name: 'kioku', version: VERSION }, { instructions: GUIDANCE })

  server.registerTool(
    'kioku_boot',
    {
      description: '加载当前终端透镜对应的常驻记忆与近期会话摘要',
      annotations: { readOnlyHint: true },
      inputSchema: {
        project: z.string().max(128).optional().describe('当前项目标识'),
        device_key: z.string().max(128).optional().describe('当前设备标识'),
      },
    },
    (args) =>
      runTool(async () => {
        const focus = synthesizeFocus(key, { project: args.project })
        const projectSlug = normalizeProjectSlug(args.project) ?? ''
        const bootResult = await compileBoot(deps.db, key, {
          focus,
          projectSlug,
          ...(args.device_key !== undefined ? { deviceKey: args.device_key } : {}),
        })
        const main = formatBootBlock(bootResult, GUIDANCE)
        const episodes = formatSummaryBlock(bootResult.episodes)
        return episodes ? `${main}\n\n${episodes}` : main
      }),
  )

  server.registerTool(
    'kioku_search',
    {
      description: '按混合检索（向量 + 中文全文 + 场景亲和 + 一跳双链）召回记忆线索',
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).max(2000).describe('查询语句或关键词'),
        limit: z.number().int().min(1).max(30).optional().describe('返回条数，默认 10'),
        env: z.string().max(64).optional().describe('临时环境焦点覆盖，如 mac、win、linux'),
        realm: z
          .string()
          .max(64)
          .optional()
          .describe('临时场域焦点覆盖（仅影响排序，不放宽密钥授权边界）'),
        project: z.string().max(64).optional().describe('临时项目焦点覆盖'),
        runtime: z.string().max(64).optional().describe('临时客户端焦点覆盖'),
      },
    },
    (args) =>
      runTool(async () => {
        const focus = synthesizeFocus(key, {
          env: args.env,
          realm: args.realm,
          project: args.project,
          runtime: args.runtime,
        })
        const candidates = await recallEntries(deps.db, deps.masterKey, key, args.query, {
          focus,
          limit: args.limit ?? 10,
        })
        if (!candidates.length) return '未召回到相关记忆。'
        return formatRecallBlock(candidates)
      }),
  )

  server.registerTool(
    'kioku_get',
    {
      description: '按短 ID（m-xxxxxx）或精确标题读取记忆正文、元数据、双链邻居与凭据引用状态',
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
      },
    },
    (args) =>
      runTool(async () => {
        const detail = await entries.get(key, args.id)
        return { text: formatEntryDetail(detail), structuredContent: detail }
      }),
  )

  server.registerTool(
    'kioku_browse',
    {
      description: '按项目、环境、场域、客户端、主题或类型分组浏览可见记忆目录',
      annotations: { readOnlyHint: true },
      inputSchema: {
        group_by: McpGroupBy.optional().describe('分组维度，默认 project'),
        kind: McpEntryKind.optional().describe('按类型过滤：entry 或 episode'),
        topic: z.string().max(64).optional().describe('按主题标签过滤'),
        project: z.string().max(64).optional().describe('按项目过滤'),
        env: z.string().max(64).optional().describe('按环境过滤'),
        realm: z.string().max(64).optional().describe('按场域过滤'),
        runtime: z.string().max(64).optional().describe('按客户端过滤'),
        pinned_only: z.boolean().optional().describe('仅看常驻启动加载词条'),
        query: z.string().max(200).optional().describe('按标题或短 ID 关键词过滤'),
        limit: z.number().int().min(1).max(200).optional().describe('最多返回条数'),
      },
    },
    (args) =>
      runTool(async () => {
        const parsed = parseInput(BrowseEntriesQuery, {
          ...(args.group_by !== undefined ? { groupBy: args.group_by } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.topic !== undefined ? { topic: args.topic } : {}),
          ...(args.project !== undefined ? { project: args.project } : {}),
          ...(args.env !== undefined ? { env: args.env } : {}),
          ...(args.realm !== undefined ? { realm: args.realm } : {}),
          ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
          ...(args.pinned_only !== undefined ? { pinnedOnly: args.pinned_only } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        })
        const res = await entries.browse(key, parsed)
        return { text: formatBrowseResponse(res), structuredContent: res }
      }),
  )

  server.registerTool(
    'kioku_create',
    {
      description:
        '新建一条扁平长期记忆，正文支持 Markdown、[[m-xxxxxx]] 双链与 {{cred:<slug>}} 占位符',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(ENTRY_TITLE_MAX)
          .optional()
          .describe('标题；省略时取正文首个 # 标题或短 ID'),
        content: z.string().min(1).max(ENTRY_CONTENT_MAX).describe('Markdown 正文'),
        topics: McpTopicList.optional().describe('主题标签列表'),
        envs: McpTagList.optional().describe('适用环境/系统，如 ["mac", "linux"]'),
        realms: McpTagList.optional().describe('适用场域，如 ["work"]；留空表示通用'),
        projects: McpTagList.optional().describe('适用项目标识列表'),
        runtimes: McpTagList.optional().describe('适用客户端标识列表'),
        is_pinned: z.boolean().optional().describe('是否作为常驻记忆在会话启动时自动注入'),
        disclosure: z
          .string()
          .max(DISCLOSURE_MAX)
          .optional()
          .describe('何时需要想起此条的简短说明'),
        valid_to: z.string().optional().describe('过期时间（ISO 8601 带时区），留空长期有效'),
      },
    },
    (args) =>
      runTool(async () => {
        const parsed = parseInput(CreateEntryRequest, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          content: args.content,
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.envs !== undefined ? { envs: args.envs } : {}),
          ...(args.realms !== undefined ? { realms: args.realms } : {}),
          ...(args.projects !== undefined ? { projects: args.projects } : {}),
          ...(args.runtimes !== undefined ? { runtimes: args.runtimes } : {}),
          ...(args.is_pinned !== undefined ? { isPinned: args.is_pinned } : {}),
          ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
          ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
        })
        const created = await entries.create(key, parsed)
        return { text: formatEntryDetail(created), structuredContent: created }
      }),
  )

  server.registerTool(
    'kioku_update',
    {
      description: '修改已有记忆的标题、正文、场景标签、常驻状态或有效期',
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
        expected_version: z.number().int().min(1).optional().describe('期望版本号（乐观锁）'),
        title: z.string().min(1).max(ENTRY_TITLE_MAX).optional(),
        content: z.string().min(1).max(ENTRY_CONTENT_MAX).optional(),
        topics: McpTopicList.optional(),
        envs: McpTagList.optional(),
        realms: McpTagList.optional(),
        projects: McpTagList.optional(),
        runtimes: McpTagList.optional(),
        is_pinned: z.boolean().optional(),
        disclosure: z.string().max(DISCLOSURE_MAX).nullable().optional(),
        valid_to: z.string().nullable().optional(),
      },
    },
    (args) =>
      runTool(async () => {
        const parsed = parseInput(UpdateEntryRequest, {
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.envs !== undefined ? { envs: args.envs } : {}),
          ...(args.realms !== undefined ? { realms: args.realms } : {}),
          ...(args.projects !== undefined ? { projects: args.projects } : {}),
          ...(args.runtimes !== undefined ? { runtimes: args.runtimes } : {}),
          ...(args.is_pinned !== undefined ? { isPinned: args.is_pinned } : {}),
          ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
          ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
        })
        const updated = await entries.update(key, args.id, parsed)
        return { text: formatEntryDetail(updated), structuredContent: updated }
      }),
  )

  server.registerTool(
    'kioku_delete',
    {
      description: '软删除一条记忆（移入回收站，可在管理界面恢复）',
      annotations: { destructiveHint: true },
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
        expected_version: z.number().int().min(1).optional().describe('期望版本号'),
      },
    },
    (args) =>
      runTool(async () => {
        await entries.remove(key, args.id, {
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
        })
        return {
          text: `已将 ${args.id} 移入回收站。`,
          structuredContent: { deleted: true, id: args.id },
        }
      }),
  )

  server.registerTool(
    'kioku_list_credentials',
    {
      description: '列出当前访问密钥允许使用的凭据标识与说明（仅元数据，绝不返回明文值）',
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    () =>
      runTool(async () => {
        const items = await credentials.listForScope(key)
        return { text: formatCredentialMetadataList(items), structuredContent: { items } }
      }),
  )

  return server
}

export async function handleMcpRequest(
  deps: Deps,
  key: KeyPrincipal,
  entries: EntryService,
  credentials: CredentialService,
  request: Request,
): Promise<Response> {
  const server = createKiokuMcpServer(deps, key, entries, credentials)
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await transport.close().catch(() => {})
    await server.close().catch(() => {})
  }
}
