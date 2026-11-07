import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  CREDENTIAL_PURPOSE_MAX,
  CreateMemoryRequest,
  CredentialFieldName,
  CredentialIdentifier,
  CredentialIdentifierQuery,
  KeyCreateCredentialRequest,
  KeyUpdateCredentialRequest,
  MemoryUri,
  type MemoryView,
  RecallRequest,
  Sensitivity,
  UpdateMemoryRequest,
  URI_FORMAT_MESSAGE,
} from '@kioku/contracts'
import { z } from 'zod'

import { looksLikePlaintextCredential, placeholderIdentifiers } from '../credential/placeholders'
import type { CredentialService } from '../credential/service'
import { logInternalError } from '../db/client'
import type { RecallScope } from '../lifecycle/scope'
import { GUIDANCE } from '../lifecycle/lifecycle'
import { hasUntouchedPlaintext, MemoryError, type MemoryService } from '../memory/service'
import { formatBootBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import { VERSION } from '../version'
import {
  formatChildren,
  formatCredentialAccess,
  formatCredentialList,
  formatCredentialSummary,
  formatCredentialUnchanged,
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

// 标题参数的说明，新建与修改共用
const TITLE_HELP =
  '标题：给人看的名字，最多 80 个字符；不填时取正文第一个 # 标题，没有就用坐标的最后一段'

// 有效到参数的说明，新建与修改共用
const VALID_TO_HELP =
  '有效到：ISO 8601，要带时区（例如 2026-12-31T23:59:00+08:00），要比现在晚至少一分钟。' +
  '只在一段时间内成立的事（临时安排、截止日期）才填，到期后不再召回、不进 boot，不填就一直有效'

// 写入的正文像有明文密码或 Token 时，在结果后面提醒换成占位符（规则与导入工具的提醒相同）。
// 新增的疑似明文在写入前就被拒了，能写进来的是原来就有的、结果是 secret 的，或者带了 plaintext_ok 的。
// plaintext_ok 只确认了这次新增的几处：正文里原来就有、没处理过的照常提醒（见 hasUntouchedPlaintext）
function withPlaintextReminder(view: MemoryView, plaintextOk: boolean | undefined): string {
  const text = formatMemory(view)
  const remind = plaintextOk
    ? hasUntouchedPlaintext(view)
    : !!view.content && looksLikePlaintextCredential(view.content)
  return remind ? `${text}\n\n${PLAINTEXT_REMINDER}` : text
}

// 新建与修改的 plaintext_ok 参数
const PLAINTEXT_OK_HELP =
  '正文里新增的疑似明文（密码、令牌这类）确实不是凭据时设为 true：照常写入，这条记忆进待处理由人看过。' +
  '是凭据时不要设，先用 kioku_credential_save 存值，正文写占位符'

// 新建与修改的工具说明里共用的一段
const PLAINTEXT_TOOL_HELP =
  '正文里不要写明文的密码、令牌与密钥：先用 kioku_credential_save 存起来，正文里写 {{cred:<标识>#<字段>}} 占位符。' +
  '正文里有新增的疑似明文时写入会被拒，错误里指出第几行、哪一类；确实不是凭据（例如示例、已经作废的值）时带上 plaintext_ok 再写。'

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
      description:
        '按语义、全文和关键词搜索记忆，返回候选的坐标（URI）、标题与线索；需要正文时再用 kioku_get。',
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
      description:
        '按坐标（URI）读取一条记忆的标题与完整正文。召回结果只是候选，引用之前先用它读正文。',
      inputSchema: { uri: MemoryUri.describe('记忆的坐标（URI），例如 core://agent') },
      annotations: { readOnlyHint: true },
    },
    ({ uri }) =>
      tool(async () => {
        const view = await memory.get(uri, 'kioku_get')
        // 占位符按记忆的所有者解析：只有本人的记忆能引用凭据，所有者就是读者自己
        const identifiers = [...placeholderIdentifiers(view.content ?? '')]
        if (!identifiers.length) return formatMemory(view)
        const found =
          view.layer === 'user'
            ? await credentials.forPlaceholders(identifiers)
            : identifiers.map((identifier) => ({
                identifier,
                state: 'unavailable' as const,
                name: null,
              }))
        return `${formatMemory(view)}\n\n${formatPlaceholderCredentials(found)}`
      }),
  )

  server.registerTool(
    'kioku_list',
    {
      description:
        '浏览记忆的目录：不带参数列出有记忆的开头（core://、user://、persona://、app://）；' +
        '给开头（如 core）或坐标（URI）时列出它下面的直接子节点，persona://<人格标识> 与 app://<应用标识> 列这个人格、应用下的第一级。',
      inputSchema: {
        of: z
          .string()
          .optional()
          .describe('开头（core、user、persona、app）或坐标（URI），例如 user://projects'),
      },
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
        `${URI_FORMAT_MESSAGE}。坐标的开头决定这条记忆归谁、谁读得到：人格与应用的记忆只能写本应用当前的人格与本应用；` +
        'user:// 下的只有本人的 agent 读得到，不能设为 public。' +
        PLAINTEXT_TOOL_HELP,
      inputSchema: {
        // 长度与数量限制和 REST 共用 contracts 里的定义
        uri: MemoryUri.describe('新记忆的坐标（URI），开头决定归属'),
        title: CreateMemoryRequest.shape.title.describe(TITLE_HELP),
        content: CreateMemoryRequest.shape.content.describe('正文'),
        disclosure: CreateMemoryRequest.shape.disclosure.describe('什么场景下需要想起这条记忆'),
        priority: CreateMemoryRequest.shape.priority.describe('0 最重要，默认 2'),
        glossary: CreateMemoryRequest.shape.glossary.describe('关键词，用于召回'),
        sensitivity: Sensitivity.optional().describe(
          '敏感级：public / internal / private / secret。不填时按归属取默认值，user:// 下默认 private、不能是 public',
        ),
        valid_to: CreateMemoryRequest.shape.validTo.describe(VALID_TO_HELP),
        plaintext_ok: z.boolean().optional().describe(PLAINTEXT_OK_HELP),
      },
    },
    (args) =>
      tool(async () =>
        withPlaintextReminder(
          await memory.create({
            uri: args.uri,
            ...(args.title ? { title: args.title } : {}),
            content: args.content,
            priority: args.priority,
            glossary: args.glossary,
            ...(args.disclosure ? { disclosure: args.disclosure } : {}),
            ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
            ...(args.valid_to ? { validTo: args.valid_to } : {}),
            ...(args.plaintext_ok ? { plaintextOk: true } : {}),
          }),
          args.plaintext_ok,
        ),
      ),
  )

  server.registerTool(
    'kioku_update',
    {
      description:
        '修改已有记忆。改之前先用 kioku_get 读正文；带上 expected_version 防止覆盖别人的修改。' +
        '改标题不改坐标；要换位置、标识或归属（坐标的开头）用 kioku_move。' +
        PLAINTEXT_TOOL_HELP +
        '原来就有的疑似明文不挡修改。',
      inputSchema: {
        uri: MemoryUri.describe('要修改的记忆的坐标（URI）'),
        title: UpdateMemoryRequest.shape.title.describe(TITLE_HELP),
        content: UpdateMemoryRequest.shape.content.describe('新的完整正文'),
        disclosure: UpdateMemoryRequest.shape.disclosure,
        priority: UpdateMemoryRequest.shape.priority,
        sensitivity: Sensitivity.optional().describe(
          '敏感级：public / internal / private / secret；user:// 下的不能是 public',
        ),
        glossary_add: UpdateMemoryRequest.shape.glossaryAdd,
        glossary_remove: UpdateMemoryRequest.shape.glossaryRemove,
        valid_to: UpdateMemoryRequest.shape.validTo.describe(
          `${VALID_TO_HELP}；填 null 清掉，一直有效`,
        ),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
        plaintext_ok: z.boolean().optional().describe(PLAINTEXT_OK_HELP),
      },
    },
    (args) =>
      tool(async () =>
        withPlaintextReminder(
          await memory.update(
            {
              uri: args.uri,
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.content !== undefined ? { content: args.content } : {}),
              ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
              ...(args.priority !== undefined ? { priority: args.priority } : {}),
              ...(args.sensitivity ? { sensitivity: args.sensitivity } : {}),
              ...(args.glossary_add ? { glossaryAdd: args.glossary_add } : {}),
              ...(args.glossary_remove ? { glossaryRemove: args.glossary_remove } : {}),
              ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
              ...(args.expected_version !== undefined
                ? { expectedVersion: args.expected_version }
                : {}),
              ...(args.plaintext_ok ? { plaintextOk: true } : {}),
            },
            { via: 'kioku_update' },
          ),
          args.plaintext_ok,
        ),
      ),
  )

  server.registerTool(
    'kioku_delete',
    {
      description: '删除一条记忆。历史事件会保留，必要时可以恢复。',
      inputSchema: { uri: MemoryUri.describe('要删除的记忆的坐标（URI）') },
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
        '修改记忆的坐标（URI）：换最后一段是改标识，换中间各级是挪位置，换开头就是改归属（例如从 core:// 移到 app://<应用>/）。' +
        '共享的归属（core://、persona://、app://）与本人（user://）之间不能通过访问密钥移动：这会改变谁读得到它，要在管理界面里由人来移。' +
        '标题不变；只有标识变了、标题又就是原来的标识时，按新坐标重新取：正文有 # 标题取它，没有就用新的标识。',
      inputSchema: {
        from: MemoryUri.describe('现在的坐标（URI）'),
        to: MemoryUri.describe('新的坐标（URI）'),
      },
    },
    ({ from, to }) => tool(async () => formatMemory(await memory.move({ from, to }, 'kioku_move'))),
  )

  server.registerTool(
    'kioku_credential',
    {
      description:
        '取用凭据。记忆正文里的 {{cred:<标识>}} 与 {{cred:<标识>#<字段>}} 是凭据占位符：给标识时返回值（totp 字段给当前的验证码），' +
        '每次取用都记一条访问事件；不给标识时列出可取用的凭据，只有说明，不含值。' +
        '用到时才取，不要把值写回记忆，也不要显示在回复里。',
      inputSchema: {
        identifier: CredentialIdentifier.optional().describe(
          '凭据的标识，即占位符里 cred: 后面的那一段',
        ),
        field: CredentialFieldName.optional().describe(
          '只取一个字段，例如 password；不填取全部字段',
        ),
        purpose: z
          .string()
          .optional()
          .describe(`这次取用是为了什么，记进访问事件，最多 ${CREDENTIAL_PURPOSE_MAX} 个字`),
      },
    },
    ({ identifier, field, purpose }) =>
      tool(async () => {
        if (!identifier) return formatCredentialList(await credentials.keyList())
        const query = parse(CredentialIdentifierQuery, { identifier, field, purpose })
        return formatCredentialAccess(
          await credentials.use(query.identifier, query.field, 'kioku_credential', query.purpose),
        )
      }),
  )

  server.registerTool(
    'kioku_credential_save',
    {
      description:
        '新建或修改凭据（要凭据能力为「管理」的访问密钥）。不给 expected_version 就是新建，新建的凭据只给这个应用用；' +
        '所有者设了密码库的去处时写进密码库，没设时由 Kioku 托管，结果里写明存在哪里。' +
        '有 username 或 password 字段的是登录类，url 用于浏览器自动填充；别的字段存成隐藏字段。' +
        '修改时先用不带参数的 kioku_credential 列出凭据，看它的版本号（不用取值）；版本号不对时，错误里会给出现在的版本号。' +
        '密码库里的凭据改值时写回原条目，只改给了的字段，不能删字段；条目在别处改过时会报错，先重新列出凭据拿到新的版本号再改。' +
        '说明里不要写值。',
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
            '值，字段名 → 值；新建时必填。修改时只给要改的字段，值为 null 表示删掉这个字段',
          ),
        url: z
          .string()
          .optional()
          .describe('新建时可选：用到这条凭据的网址（http 或 https），写进密码库的条目'),
        expires_at: z
          .string()
          .nullable()
          .optional()
          .describe('到期时间，带时区的 ISO 时间，例如 2027-01-01T00:00:00Z；修改时给 null 清掉'),
        expected_version: z.number().int().optional().describe('修改时必填：读取时看到的版本号'),
      },
    },
    (args) =>
      tool(async () => {
        if (args.expected_version === undefined) {
          const input = parse(KeyCreateCredentialRequest, {
            identifier: args.identifier,
            name: args.name,
            description: args.description,
            values: args.values,
            url: args.url,
            expiresAt: args.expires_at,
          })
          const created = await credentials.keyCreate(input)
          return formatCredentialSummary('已新建', created, created.storedIn)
        }
        const { identifier, ...input } = parse(KeyUpdateCredentialRequest, {
          identifier: args.identifier,
          expectedVersion: args.expected_version,
          name: args.name,
          description: args.description,
          values: args.values,
          expiresAt: args.expires_at,
        })
        const updated = await credentials.keyUpdate(identifier, input)
        // 什么都没改时版本号不变：如实说没有改动，不说已修改
        if (updated.version === input.expectedVersion) {
          return formatCredentialUnchanged(updated, input.values !== undefined)
        }
        return formatCredentialSummary('已修改', updated)
      }),
  )

  server.registerTool(
    'kioku_credential_delete',
    {
      description: '删除凭据（软删除，所有者可以在管理界面恢复）。密码库里的条目不受影响。',
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
