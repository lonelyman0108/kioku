import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  BOOT_MODES,
  BROWSE_GROUP_BY,
  BrowseEntriesQuery,
  CHANGE_SUMMARY_MAX,
  ChangeSummary,
  CreateEntryRequest,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_KINDS,
  ENTRY_SUMMARY_MAX,
  ENTRY_TITLE_MAX,
  ENTRY_TITLE_NEW_MAX,
  extractMarkdownOutline,
  extractMarkdownSection,
  normalizeProjectSlug,
  SCENE_TAGS_MAX,
  stripDuplicateLeadingHeading,
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
  formatEntryHistory,
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
const McpBootMode = z.enum(BOOT_MODES)
const McpGroupBy = z.enum(BROWSE_GROUP_BY)
const McpPatchSchema = z.object({
  kind: z
    .enum(['replace', 'insert_under_heading', 'append'])
    .describe(
      '局部补丁方式：replace（精确替换片段）、insert_under_heading（插入到二级小节末）、append（文末追加）',
    ),
  old_text: z.string().optional().describe('kind=replace 时待替换的原正文片段（须唯一匹配）'),
  new_text: z.string().optional().describe('kind=replace 时的替换后片段'),
  heading: z.string().max(200).optional().describe('kind=insert_under_heading 时的二级小节标题'),
  text: z.string().optional().describe('kind=insert_under_heading 或 append 时要写入的文本'),
})

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
        env: z.string().max(64).optional().describe('临时环境焦点覆盖，如 mac、win、linux'),
        realm: z
          .string()
          .max(64)
          .optional()
          .describe('临时场域焦点覆盖（仅影响启动聚焦，不放宽密钥授权边界）'),
        runtime: z.string().max(64).optional().describe('临时客户端标识覆盖，支持自定义客户端名'),
      },
    },
    (args) =>
      runTool(async () => {
        const focus = synthesizeFocus(key, {
          project: args.project,
          env: args.env,
          realm: args.realm,
          runtime: args.runtime,
        })
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
      description: '按混合检索（向量 + 加权中文全文 + 场景亲和 + 一跳双链）召回记忆线索',
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
      description:
        '按短 ID（m-xxxxxx）或精确标题读取记忆正文、现行概要、更新时间、双链邻居与凭据状态；支持先看大纲或按二级小节直取',
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
        view: z
          .enum(['full', 'outline'])
          .optional()
          .describe('视图模式：full（默认返回全文）或 outline（仅返回概要与二级小节目录）'),
        section: z
          .string()
          .max(200)
          .optional()
          .describe('仅读取指定的二级小节（## 标题），适合超长手册按需提取'),
      },
    },
    (args) =>
      runTool(async () => {
        const detail = await entries.get(key, args.id)
        const text = formatEntryDetail(detail, { view: args.view, section: args.section })
        if (args.section || args.view === 'outline') {
          const cleanBody = stripDuplicateLeadingHeading(detail.entry.title, detail.entry.content)
          const entryMeta = Object.fromEntries(
            Object.entries(detail.entry).filter(([field]) => field !== 'content'),
          )
          if (args.section) {
            const matched = extractMarkdownSection(cleanBody, args.section)
            return {
              text,
              structuredContent: {
                entry: entryMeta,
                section: matched,
                outboundLinks: detail.outboundLinks,
                backlinks: detail.backlinks,
                credentialRefs: detail.credentialRefs,
                ...(detail.recentHistory ? { recentHistory: detail.recentHistory } : {}),
              },
            }
          }
          return {
            text,
            structuredContent: {
              entry: entryMeta,
              outline: extractMarkdownOutline(cleanBody),
              contentLength: cleanBody.length,
              outboundLinks: detail.outboundLinks,
              backlinks: detail.backlinks,
              credentialRefs: detail.credentialRefs,
              ...(detail.recentHistory ? { recentHistory: detail.recentHistory } : {}),
            },
          }
        }
        return {
          text,
          structuredContent: detail,
        }
      }),
  )

  server.registerTool(
    'kioku_history',
    {
      description:
        '读取单条记忆的语义化变更时间线，或按 version 查阅特定历史版本快照（默认不返回大快照，节省上下文）',
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
        limit: z.number().int().min(1).max(50).optional().describe('返回最近条数，默认 10'),
        version: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('指定版本号时返回该版本的完整快照正文'),
      },
    },
    (args) =>
      runTool(async () => {
        const res = await entries.history(key, args.id, {
          limit: args.limit ?? 10,
          ...(args.version !== undefined ? { version: args.version } : {}),
          includeSnapshots: args.version !== undefined,
        })
        return {
          text: formatEntryHistory(args.id, res, args.version),
          structuredContent: res,
        }
      }),
  )

  server.registerTool(
    'kioku_browse',
    {
      description: '按项目、环境、场域、客户端、主题或类型分组浏览可见记忆目录（含更新时间与体量）',
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
        '新建一条扁平长期记忆；标题应简短稳定且不含日期/更新日志，正文只写现行状态与长期原因，支持 [[m-xxxxxx|语境]] 双链与 {{cred:<slug>}} 占位符',
      inputSchema: {
        title: z
          .string()
          .min(1)
          .max(ENTRY_TITLE_NEW_MAX)
          .optional()
          .describe('简短稳定的主题名（建议 ≤24 字，上限 80 字），严禁写入日期或变更日志'),
        summary: z
          .string()
          .max(ENTRY_SUMMARY_MAX)
          .optional()
          .describe('1–2 句现行结论摘要（≤300 字），供启动加载目录与检索速览'),
        content: z
          .string()
          .min(1)
          .max(ENTRY_CONTENT_MAX)
          .describe('Markdown 正文（维护现行状态与长期原因，无需在首行重复标题）'),
        change_summary: z
          .string()
          .max(CHANGE_SUMMARY_MAX)
          .optional()
          .describe('初始建立背景说明（单行，写入版本历史）'),
        topics: McpTopicList.optional().describe('主题标签列表'),
        envs: McpTagList.optional().describe('适用环境/系统，如 ["mac", "linux"]'),
        realms: McpTagList.optional().describe('适用场域，如 ["work"]；留空表示通用'),
        projects: McpTagList.optional().describe('适用项目标识列表'),
        runtimes: McpTagList.optional().describe('适用客户端标识列表（支持自定义客户端标识）'),
        boot_mode: McpBootMode.optional().describe(
          '启动加载方式：full（全文常驻，仅放极简跨会话铁律，建议 ≤1200 字）、index（目录常驻，适合长篇参考手册，会话启动仅展示摘要行）、none（按需召回，默认）',
        ),
        is_pinned: z
          .boolean()
          .optional()
          .describe(
            '兼容参数：true 等价于 boot_mode=full，false 等价于 none；同时传入时以 boot_mode 为准',
          ),
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
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          content: args.content,
          ...(args.change_summary !== undefined ? { changeSummary: args.change_summary } : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.envs !== undefined ? { envs: args.envs } : {}),
          ...(args.realms !== undefined ? { realms: args.realms } : {}),
          ...(args.projects !== undefined ? { projects: args.projects } : {}),
          ...(args.runtimes !== undefined ? { runtimes: args.runtimes } : {}),
          ...(args.boot_mode !== undefined ? { bootMode: args.boot_mode } : {}),
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
      description:
        '修改已有记忆的现行状态、概要或元数据；修改长文档时优先使用 patch 局部补丁以免误覆盖主体，并填写 change_summary 记录变更原因',
      inputSchema: {
        id: z.string().min(1).max(200).describe('记忆短 ID（如 m-234abc）或精确标题'),
        expected_version: z.number().int().min(1).optional().describe('期望版本号（乐观锁）'),
        title: z
          .string()
          .min(1)
          .max(ENTRY_TITLE_MAX)
          .optional()
          .describe('稳定短主题名（建议 ≤24 字），严禁写入日期或变更日志'),
        summary: z
          .string()
          .max(ENTRY_SUMMARY_MAX)
          .nullable()
          .optional()
          .describe('1–2 句现行结论摘要（传入 null 清空）'),
        content: z
          .string()
          .min(1)
          .max(ENTRY_CONTENT_MAX)
          .optional()
          .describe('整篇替换正文（与 patch 互斥）；维护现行状态与原因，不堆砌历史流水账'),
        patch: McpPatchSchema.optional().describe(
          '局部补丁更新（与 content 互斥），修改长文档优先使用以避免误删无关段落',
        ),
        change_summary: z
          .string()
          .max(CHANGE_SUMMARY_MAX)
          .optional()
          .describe('本次改了什么及原因（单行），写入版本历史并在召回/列表中展示'),
        verified: z.boolean().optional().describe('设为 true 刷新事实最近核实时间'),
        topics: McpTopicList.optional().describe('覆盖主题标签列表'),
        envs: McpTagList.optional().describe('覆盖适用环境列表'),
        realms: McpTagList.optional().describe('覆盖适用场域列表'),
        projects: McpTagList.optional().describe('覆盖适用项目列表'),
        runtimes: McpTagList.optional().describe('覆盖适用客户端列表（支持自定义客户端标识）'),
        boot_mode: McpBootMode.optional().describe(
          '修改启动加载方式：full（全文常驻，仅放极简跨会话铁律）、index（目录常驻，仅注入摘要目录行）、none（按需召回）',
        ),
        is_pinned: z
          .boolean()
          .optional()
          .describe('兼容参数：设为 true 标为常驻，false 取消常驻；同时传入时以 boot_mode 为准'),
        disclosure: z
          .string()
          .max(DISCLOSURE_MAX)
          .nullable()
          .optional()
          .describe('触发场景说明（传入 null 清空）'),
        valid_to: z
          .string()
          .nullable()
          .optional()
          .describe('过期时间（ISO 8601 带时区，传入 null 改为长期有效）'),
      },
    },
    (args) =>
      runTool(async () => {
        let patchPayload: Record<string, unknown> | undefined
        if (args.patch) {
          if (args.patch.kind === 'replace') {
            patchPayload = {
              kind: 'replace',
              oldText: args.patch.old_text ?? '',
              newText: args.patch.new_text ?? args.patch.text ?? '',
            }
          } else if (args.patch.kind === 'insert_under_heading') {
            patchPayload = {
              kind: 'insert_under_heading',
              heading: args.patch.heading ?? '',
              text: args.patch.text ?? '',
            }
          } else {
            patchPayload = {
              kind: 'append',
              text: args.patch.text ?? '',
            }
          }
        }
        const parsed = parseInput(UpdateEntryRequest, {
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(patchPayload !== undefined ? { patch: patchPayload } : {}),
          ...(args.change_summary !== undefined ? { changeSummary: args.change_summary } : {}),
          ...(args.verified !== undefined ? { verified: args.verified } : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.envs !== undefined ? { envs: args.envs } : {}),
          ...(args.realms !== undefined ? { realms: args.realms } : {}),
          ...(args.projects !== undefined ? { projects: args.projects } : {}),
          ...(args.runtimes !== undefined ? { runtimes: args.runtimes } : {}),
          ...(args.boot_mode !== undefined ? { bootMode: args.boot_mode } : {}),
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
        change_summary: z
          .string()
          .max(CHANGE_SUMMARY_MAX)
          .optional()
          .describe('删除或退场原因（写入版本历史）'),
      },
    },
    (args) =>
      runTool(async () => {
        const changeSummary =
          args.change_summary !== undefined
            ? parseInput(ChangeSummary, args.change_summary)
            : undefined
        await entries.remove(key, args.id, {
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
          ...(changeSummary !== undefined ? { changeSummary } : {}),
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
