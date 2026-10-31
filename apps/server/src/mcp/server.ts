import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CreateMemoryRequest,
  CredentialFieldName,
  CredentialIdentifier,
  KeyCreateCredentialRequest,
  KeyUpdateCredentialRequest,
  Layer,
  MemoryUri,
  PlainLayer,
  type MemoryView,
  RecallRequest,
  Sensitivity,
  UpdateMemoryRequest,
} from '@kioku/contracts'
import { z } from 'zod'

import { looksLikePlaintextCredential, placeholderIdentifiers } from '../credential/placeholders'
import type { CredentialService } from '../credential/service'
import { logInternalError } from '../db/client'
import type { RecallScope } from '../lifecycle/scope'
import { GUIDANCE } from '../lifecycle/lifecycle'
import { MemoryError, type MemoryService } from '../memory/service'
import { formatBootBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import { VERSION } from '../version'
import {
  formatChildren,
  formatCredentialAccess,
  formatCredentialList,
  formatCredentialSummary,
  formatDomains,
  formatMemory,
  formatPlaceholderCredentials,
  PLAINTEXT_REMINDER,
  TOOL_INTERNAL_ERROR,
} from './format'

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

// 业务错误作为工具错误返回给模型，让它能据此调整。其余错误只回固定文字、详情进日志：
// 抛出去的话 SDK 会把 message 变成工具结果，而 drizzle 的错误信息带着 SQL 与全部参数
async function tool(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] }
  } catch (err) {
    if (err instanceof MemoryError)
      return { content: [{ type: 'text', text: err.message }], isError: true }
    logInternalError('MCP 工具内部错误', err)
    return { content: [{ type: 'text', text: TOOL_INTERNAL_ERROR }], isError: true }
  }
}

// 工具参数按 contracts 里的请求定义再校验一遍（例如字段名不能重复），不通过时作为工具错误返回
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
  throw new MemoryError(400, `${where}${issue?.message ?? '参数格式错误'}`)
}

// 有效到参数的说明，新建与修改共用
const VALID_TO_HELP =
  '有效到：ISO 8601，要带时区（例如 2026-12-31T23:59:00+08:00），要比现在晚至少一分钟。' +
  '只在一段时间内成立的事（临时安排、截止日期）才填，到期后不再召回、不进 boot，不填就一直有效'

// 写入的正文像有明文密码或 Token 时，在结果后面提醒换成占位符（规则与导入工具的提醒相同）
function withPlaintextReminder(view: MemoryView): string {
  const text = formatMemory(view)
  return view.content && looksLikePlaintextCredential(view.content)
    ? `${text}\n\n${PLAINTEXT_REMINDER}`
    : text
}

interface CredentialSourceArgs {
  values?: Record<string, string | null> | undefined
  provider_id?: string | undefined
  location?: string | undefined
  fields?: { name: string; source_field: string }[] | undefined
}

// 托管的给 values，外部的给 provider_id、location 与 fields；都没给表示不改来源
function sourceFromArgs(args: CredentialSourceArgs) {
  const external =
    args.provider_id !== undefined || args.location !== undefined || args.fields !== undefined
  if (args.values !== undefined && external) {
    throw new MemoryError(
      400,
      'values（Kioku 托管）与 provider_id、location、fields（外部凭据源）只能给一种',
    )
  }
  if (args.values !== undefined) return { kind: 'hosted' as const, values: args.values }
  if (!external) return undefined
  return {
    kind: 'external' as const,
    providerId: args.provider_id,
    location: args.location,
    fields: args.fields?.map((f) => ({ name: f.name, sourceField: f.source_field })),
  }
}

export function buildMcpServer(
  memory: MemoryService,
  scope: RecallScope,
  credentials: CredentialService,
): McpServer {
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
        scope.record('mcp.search', query, candidates)
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
    ({ uri }) =>
      tool(async () => {
        const view = await memory.get(uri, 'kioku_get')
        // 占位符按记忆的主人解析：只有私人层的记忆能引用凭据，主人就是读者自己
        const identifiers = [...placeholderIdentifiers(view.content ?? '')]
        if (!identifiers.length) return formatMemory(view)
        const found =
          view.layer === 'private'
            ? await credentials.forPlaceholders(identifiers)
            : identifiers.map((identifier) => ({ identifier, available: false as const }))
        return `${formatMemory(view)}\n\n${formatPlaceholderCredentials(found)}`
      }),
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
        of
          ? formatChildren(await memory.children(of, 'kioku_list'))
          : formatDomains(await memory.domains()),
      ),
  )

  server.registerTool(
    'kioku_create',
    {
      description:
        '新建一条长期记忆。正文要自带背景（为什么、在什么条件下），disclosure 写清楚什么场景下该想起它。' +
        'persona://<人格>/ 与 app://<应用>/ 下的记忆分别属于人格层和应用层，只能写本应用当前的人格与本应用；' +
        '其余 domain 不指定 layer 时按私人层保存。',
      inputSchema: {
        // 长度与数量限制和 REST 共用 contracts 里的定义
        uri: MemoryUri.describe('新记忆的 URI'),
        content: CreateMemoryRequest.shape.content.describe('正文'),
        disclosure: CreateMemoryRequest.shape.disclosure.describe('什么场景下需要想起这条记忆'),
        priority: CreateMemoryRequest.shape.priority.describe('0 最重要，默认 2'),
        glossary: CreateMemoryRequest.shape.glossary.describe('关键词，用于召回'),
        layer: Layer.optional().describe('层：base / owner / private 等'),
        sensitivity: Sensitivity.optional().describe(
          '敏感级：public / internal / private / secret',
        ),
        valid_to: CreateMemoryRequest.shape.validTo.describe(VALID_TO_HELP),
      },
    },
    (args) =>
      tool(async () =>
        withPlaintextReminder(
          await memory.create({
            uri: args.uri,
            content: args.content,
            priority: args.priority,
            glossary: args.glossary,
            ...(args.disclosure ? { disclosure: args.disclosure } : {}),
            ...(args.layer ? { layer: args.layer } : {}),
            ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
            ...(args.valid_to ? { validTo: args.valid_to } : {}),
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
        content: UpdateMemoryRequest.shape.content.describe('新的完整正文'),
        disclosure: UpdateMemoryRequest.shape.disclosure,
        priority: UpdateMemoryRequest.shape.priority,
        sensitivity: Sensitivity.optional(),
        layer: PlainLayer.optional().describe(
          '新的层。只能在 owner 与 private 之间改；与 base 互转会改变谁看得到它，要在管理界面里改',
        ),
        glossary_add: UpdateMemoryRequest.shape.glossaryAdd,
        glossary_remove: UpdateMemoryRequest.shape.glossaryRemove,
        valid_to: UpdateMemoryRequest.shape.validTo.describe(
          `${VALID_TO_HELP}；填 null 清掉，一直有效`,
        ),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
      },
    },
    (args) =>
      tool(async () =>
        withPlaintextReminder(
          await memory.update(
            {
              uri: args.uri,
              ...(args.content !== undefined ? { content: args.content } : {}),
              ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
              ...(args.priority !== undefined ? { priority: args.priority } : {}),
              ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
              ...(args.layer ? { layer: args.layer } : {}),
              ...(args.glossary_add ? { glossaryAdd: args.glossary_add } : {}),
              ...(args.glossary_remove ? { glossaryRemove: args.glossary_remove } : {}),
              ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
              ...(args.expected_version !== undefined
                ? { expectedVersion: args.expected_version }
                : {}),
            },
            { via: 'kioku_update' },
          ),
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
        '修改记忆的 URI（改名或移到别的父节点下）。移到 persona:// 或 app:// 下时层跟着 URI 变；' +
        '从那里移出时要用 layer 指定新的层（base、owner 或 private）。',
      inputSchema: {
        from: MemoryUri,
        to: MemoryUri,
        layer: PlainLayer.optional().describe('移出 persona:// 或 app:// 时的新层'),
      },
    },
    ({ from, to, layer }) =>
      tool(async () =>
        formatMemory(await memory.move({ from, to, ...(layer ? { layer } : {}) }, 'kioku_move')),
      ),
  )

  server.registerTool(
    'kioku_credential',
    {
      description:
        '取用凭据。记忆正文里的 {{cred:<标识>}} 与 {{cred:<标识>#<字段>}} 是凭据占位符：给标识时，' +
        'Kioku 托管的返回值，外部凭据源的返回凭据源、条目位置和取法，取到时记一条访问事件；不给标识时列出看得到的凭据与凭据源。' +
        '用到时才取，不要把值写回记忆，也不要显示在回复里。',
      inputSchema: {
        identifier: CredentialIdentifier.optional().describe(
          '凭据的标识，即占位符里 cred: 后面的那一段',
        ),
        field: CredentialFieldName.optional().describe(
          '只取一个字段，例如 password；不填取全部字段',
        ),
      },
    },
    ({ identifier, field }) =>
      tool(async () =>
        identifier
          ? formatCredentialAccess(await credentials.use(identifier, field, 'kioku_credential'))
          : formatCredentialList(await credentials.keyList()),
      ),
  )

  server.registerTool(
    'kioku_credential_save',
    {
      description:
        '新建或修改凭据（要能读写私人层的 secret 级 Key）。不给 expected_version 就是新建，新建的凭据只给这个应用用；' +
        '修改时先用不带参数的 kioku_credential 列出凭据，看它的版本号（不用取值）；版本号不对时，错误里会给出现在的版本号。值由 Kioku 托管时给 values；值在外部密码管理器里时给 provider_id、location 与 fields，' +
        'Kioku 只记条目位置、不存值。说明里不要写值。',
      inputSchema: {
        identifier: CredentialIdentifier.describe(
          '凭据的标识，创建后不能改；记忆里用 {{cred:<标识>#<字段>}} 引用',
        ),
        name: z.string().optional().describe('名称；新建时必填'),
        description: z.string().nullable().optional().describe('说明：用途、在哪里用'),
        values: z
          .record(CredentialFieldName, z.string().nullable())
          .optional()
          .describe(
            'Kioku 托管的值，字段名 → 值；修改时只给要改的字段，值为 null 表示删掉这个字段',
          ),
        provider_id: z
          .string()
          .optional()
          .describe('外部凭据源的 id，用不带参数的 kioku_credential 列出'),
        location: z.string().optional().describe('外部条目的位置：条目名、id 或路径'),
        fields: z
          .array(z.object({ name: CredentialFieldName, source_field: z.string() }))
          .optional()
          .describe('外部来源的字段对应：占位符里的字段名 → 条目里的字段'),
        expected_version: z.number().int().optional().describe('修改时必填：读取时看到的版本号'),
      },
    },
    (args) =>
      tool(async () => {
        const source = sourceFromArgs(args)
        if (args.expected_version === undefined) {
          const input = parse(KeyCreateCredentialRequest, {
            identifier: args.identifier,
            name: args.name,
            description: args.description,
            source,
          })
          return formatCredentialSummary('已新建', await credentials.keyCreate(input))
        }
        const { identifier, ...input } = parse(KeyUpdateCredentialRequest, {
          identifier: args.identifier,
          expectedVersion: args.expected_version,
          name: args.name,
          description: args.description,
          source,
        })
        return formatCredentialSummary('已修改', await credentials.keyUpdate(identifier, input))
      }),
  )

  server.registerTool(
    'kioku_credential_delete',
    {
      description: '删除凭据（软删除，主人可以在管理界面恢复）。',
      inputSchema: {
        identifier: CredentialIdentifier,
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
      },
      annotations: { destructiveHint: true },
    },
    ({ identifier, expected_version }) =>
      tool(async () => {
        await credentials.keyDelete(identifier, expected_version)
        return `已删除凭据 ${identifier}`
      }),
  )

  return server
}

// 无状态模式：每个请求一个服务器实例，不在进程里保存会话，方便多实例部署
export async function handleMcpRequest(
  memory: MemoryService,
  scope: RecallScope,
  credentials: CredentialService,
  request: Request,
): Promise<Response> {
  const server = buildMcpServer(memory, scope, credentials)
  // 不传 sessionIdGenerator 即无状态模式
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    await server.close()
  }
}
