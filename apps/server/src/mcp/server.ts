import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import {
  BrowseEntriesQuery,
  CREDENTIAL_PURPOSE_MAX,
  CreateEntryRequest,
  CredentialFieldName,
  CredentialIdentifier,
  CredentialIdentifierQuery,
  DeleteEntryRequest,
  DISCLOSURE_MAX,
  ENTRY_CONTENT_MAX,
  ENTRY_TITLE_MAX,
  GLOSSARY_MAX,
  KeyCreateCredentialRequest,
  KeyUpdateCredentialRequest,
  MAX_WHEN_TERMS_PER_DIMENSION,
  SENSITIVITIES,
  sensitivityRank,
  TOPICS_MAX,
  TransferEntryRequest,
  UpdateEntryRequest,
  VARIANTS_MAX,
  WhenCondition,
  type EntryView,
} from '@kioku/contracts'
import { z } from 'zod'

import { looksLikePlaintextCredential, placeholderIdentifiers } from '../credential/placeholders'
import type { CredentialService } from '../credential/service'
import { loggableError, logInternalError } from '../db/client'
import { guidanceFor, GUIDANCE } from '../lifecycle/lifecycle'
import type { RecallScope } from '../lifecycle/scope'
import { hasUntouchedPlaintext, MemoryError, type EntryService } from '../memory/service'
import { formatBootBlock } from '../recall/boot'
import { formatRecallBlock } from '../recall/recall'
import { formatSubjectBlock } from '../recall/subjects'
import { VERSION } from '../version'
import {
  formatBrowse,
  formatCredentialAccess,
  formatCredentialList,
  formatCredentialSummary,
  formatCredentialUnchanged,
  formatEntry,
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

// 工具参数按 contracts 里的请求定义再校验一遍，不通过时作为工具错误返回
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
  throw new MemoryError(400, `${where}${issue?.message ?? '参数格式错误'}`)
}

// MCP SDK 会把 inputSchema 转成 JSON Schema 给外部调用方：
// 不能直接放入带 .meta({ id }) 或 .transform() 的契约 schema，否则会产生 $ref / definitions 或转换失败
const McpSensitivity = z.enum(SENSITIVITIES)
const McpEntryKind = z.enum(['entry', 'fact', 'episode'])
const McpBrowseGroupBy = z.enum(['circle', 'realm', 'env', 'runtime', 'project', 'topic', 'kind'])
const McpWhen = z
  .record(
    z.string().min(1).max(32),
    z.array(z.string().min(1).max(64)).max(MAX_WHEN_TERMS_PER_DIMENSION),
  )
  .describe('切面条件映射（维度键 -> 词条标识数组），例如 {"env":["mac"],"realm":["work"]}')

const McpVariant = z.object({
  when: McpWhen.optional().describe('适用切面条件；通用底座省略或传 {}'),
  content: z.string().min(1).max(ENTRY_CONTENT_MAX).describe('切片正文'),
  sort_order: z
    .number()
    .int()
    .min(0)
    .max(999)
    .optional()
    .describe('展示与拼接顺序，默认按数组顺序'),
})

const TITLE_HELP =
  '标题：给人看的名字，最多 200 个字符；不填时取正文第一个 # 标题，没有就用短 ID 兜底'
const VALID_TO_HELP =
  '有效到：ISO 8601，要带时区（例如 2026-12-31T23:59:00+08:00），要比现在晚至少一分钟。' +
  '只在一段时间内成立的事（临时安排、截止日期）才填，到期后不再召回、不进 boot，不填就一直有效'
const PLAINTEXT_OK_HELP =
  '正文里新增的疑似明文（密码、令牌这类）确实不是凭据时设为 true：照常写入，这条词条进待处理由人看过。' +
  '是凭据时不要设，先用 kioku_credential_save 存值，正文写占位符'
const PLAINTEXT_TOOL_HELP =
  '正文里不要写明文的密码、令牌与密钥：先用 kioku_credential_save 存起来，正文里写 {{cred:<标识>#<字段>}} 占位符。' +
  '正文里有新增的疑似明文时写入会被拒，错误里指出第几行、哪一类；确实不是凭据（例如示例、已作废的值）时带上 plaintext_ok 再写。'

function withPlaintextReminder(
  view: EntryView,
  plaintextOk: boolean | undefined,
  options?: { requestedId?: string },
): string {
  const text = formatEntry(view, options)
  const remind = plaintextOk
    ? hasUntouchedPlaintext(view)
    : view.sensitivity !== 'secret' &&
      view.variants.some((v) => v.content !== null && looksLikePlaintextCredential(v.content))
  return remind ? `${text}\n\n${PLAINTEXT_REMINDER}` : text
}

export function buildMcpServer(
  entries: EntryService,
  scope: RecallScope,
  credentials: CredentialService,
  instructions?: string,
): McpServer {
  const server = new McpServer(
    { name: 'kioku', version: VERSION },
    instructions ? { instructions } : undefined,
  )

  server.registerTool(
    'kioku_boot',
    {
      description:
        '读取启动基线：完整使用指引、独立人格设定以及按当前切面编译后的 priority 0 核心词条。没有启动钩子的客户端在会话开始时应先调用一次；长对话或上下文压缩后也可用它重新校准。',
      annotations: { readOnlyHint: true },
    },
    () =>
      tool(async () => {
        const result = await scope.boot()
        return formatBootBlock(result, guidanceFor(false, await scope.settings()))
      }),
  )

  server.registerTool(
    'kioku_search',
    {
      description:
        '按语义、全文、关键词与切面亲和度搜索记忆，返回候选短 ID、标题、匹配切面与线索；需要正文时再用 kioku_get。回答涉及历史决定、环境约束或用户偏好的问题前，即使没有提示词触发也应主动搜索确认。',
      inputSchema: {
        query: z.string().trim().min(1).max(2000).describe('要找的内容，用自然语言描述'),
        limit: z.number().int().min(1).max(30).optional().describe('最多返回几条，默认 10'),
        facets: McpWhen.optional().describe(
          '显式临时聚焦的切面条件（仅影响存在感加权，不放宽安全边界）',
        ),
        cross_circle: z
          .boolean()
          .optional()
          .describe('是否同时搜索有权限的关联客场记忆圈，默认 true'),
        include_subjects: z.boolean().optional().describe('是否附带当前聊天对象事实，默认 true'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, facets, cross_circle, include_subjects }) =>
      tool(async () => {
        const parsedFacets = facets !== undefined ? parse(WhenCondition, facets) : undefined
        const candidates = await scope.recall(query, {
          limit: limit ?? 10,
          minScore: 0,
          ...(parsedFacets !== undefined ? { facets: parsedFacets } : {}),
          ...(cross_circle !== undefined ? { crossCircle: cross_circle } : {}),
        })
        scope.record('mcp.search', query, candidates)
        const recallBlock = formatRecallBlock(
          candidates,
          undefined,
          undefined,
          undefined,
          scope.primaryCircleId,
        )
        const subjectBlock =
          include_subjects === false ? '' : formatSubjectBlock(await scope.subjects())
        return [recallBlock, subjectBlock].filter(Boolean).join('\n\n') || '没有找到相关记忆'
      }),
  )

  server.registerTool(
    'kioku_get',
    {
      description:
        '按短 ID（m-xxxxxx）、旧版坐标或精确标题读取词条的正文与关联双链。默认只返回与当前在场切面相容的变体切片并列出其余可用切面；传 all_variants: true 可看全量。召回结果只是线索，引用前先用它读正文。',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .describe('词条短 ID（例如 m-234567）、旧版坐标 URI 或精确标题'),
        variant_filter: McpWhen.optional().describe('按指定切面过滤返回匹配的变体切片'),
        all_variants: z
          .boolean()
          .optional()
          .describe('为 true 时返回该词条下的全量变体切片，默认按当前在场切面过滤'),
        circle: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe('精确标题遇到重名时限定目标记忆圈标识（slug 或 UUID）'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ id, variant_filter, all_variants, circle }) =>
      tool(async () => {
        const parsedFilter =
          variant_filter !== undefined ? parse(WhenCondition, variant_filter) : undefined
        const currentFocus = !all_variants && !parsedFilter ? await scope.focus() : undefined
        const view = await entries.get(
          {
            id,
            ...(circle !== undefined ? { circle } : {}),
            ...(all_variants !== undefined ? { allVariants: all_variants } : {}),
            ...(parsedFilter !== undefined ? { variantFilter: parsedFilter } : {}),
            ...(currentFocus !== undefined ? { focus: currentFocus } : {}),
          },
          'kioku_get',
        )
        const identifiers = [
          ...new Set(view.variants.flatMap((v) => [...placeholderIdentifiers(v.content ?? '')])),
        ]
        if (!identifiers.length) return formatEntry(view, { requestedId: id })
        const circleKind = entries.access.circles.get(view.circleId)?.circleKind
        const canResolve =
          view.circleId === scope.primaryCircleId &&
          circleKind === 'personal' &&
          view.kind === 'entry' &&
          sensitivityRank(view.sensitivity) >= sensitivityRank('private')
        const found = canResolve
          ? await credentials.forPlaceholders(identifiers)
          : identifiers.map((identifier) => ({
              identifier,
              state: 'unavailable' as const,
              name: null,
            }))
        return `${formatEntry(view, { requestedId: id })}\n\n${formatPlaceholderCredentials(found)}`
      }),
  )

  server.registerTool(
    'kioku_browse',
    {
      description:
        '按指定维度或主题动态分组浏览可见记忆词条，返回短 ID、标题、敏感级、摘要与可用切面列表。',
      inputSchema: {
        group_by: McpBrowseGroupBy.optional().describe(
          '分组维度：circle / realm / env / runtime / project / topic / kind，默认 topic',
        ),
        circle: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe('仅看指定记忆圈（slug 或 UUID）'),
        kind: McpEntryKind.optional().describe('按物种过滤：entry / fact / episode'),
        topic: z.string().trim().min(1).max(64).optional().describe('按主题标签过滤'),
        facets: McpWhen.optional().describe('按切面条件交集过滤'),
        query: z.string().trim().max(200).optional().describe('按标题、正文或关键词过滤'),
        limit: z.number().int().min(1).max(500).optional().describe('最多返回词条数，默认 100'),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => {
        const query = parse(BrowseEntriesQuery, {
          ...(args.group_by !== undefined ? { groupBy: args.group_by } : {}),
          ...(args.circle !== undefined ? { circle: args.circle } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          ...(args.topic !== undefined ? { topic: args.topic } : {}),
          ...(args.facets !== undefined ? { facets: args.facets } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        })
        return formatBrowse(await entries.browse(query))
      }),
  )

  server.registerTool(
    'kioku_create',
    {
      description:
        '新建一条长期记忆词条（服务端自动分配全局唯一短 ID m-xxxxxx，支持 [[m-xxxxxx]] 双链）。' +
        '普通记忆直接传 content 与可选 when；同主题跨环境差异规范可用 variants 一次写入多个切面切片。' +
        '不传 circle 时写入当前主场圈，传 circle 可写入有写权限的关联圈。个人圈默认 private；共享圈默认 internal。' +
        PLAINTEXT_TOOL_HELP,
      inputSchema: {
        title: z.string().trim().min(1).max(ENTRY_TITLE_MAX).optional().describe(TITLE_HELP),
        content: z
          .string()
          .min(1)
          .max(ENTRY_CONTENT_MAX)
          .optional()
          .describe('单切片正文；与 variants 二选一'),
        when: McpWhen.optional().describe('单切片时的适用切面条件；通用词条可省略或传 {}'),
        variants: z
          .array(McpVariant)
          .min(1)
          .max(VARIANTS_MAX)
          .optional()
          .describe('多变体切片数组；与 content 二选一'),
        circle: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe('写入的目标记忆圈 slug 或 UUID；不填写入主场圈'),
        topics: z
          .array(z.string().trim().min(1).max(64))
          .max(TOPICS_MAX)
          .optional()
          .describe('主题分类标签，用于动态分组浏览'),
        disclosure: z
          .string()
          .trim()
          .max(DISCLOSURE_MAX)
          .optional()
          .describe('什么场景下需要想起这条词条'),
        priority: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe('0 最重要（进入 boot），默认 2'),
        glossary: z
          .array(z.string().trim().min(2).max(64))
          .max(GLOSSARY_MAX)
          .optional()
          .describe('关键词，用于精确召回'),
        sensitivity: McpSensitivity.optional().describe(
          '敏感级：public / internal / private / secret；个人圈默认 private，共享圈默认 internal',
        ),
        valid_to: z.string().optional().describe(VALID_TO_HELP),
        plaintext_ok: z.boolean().optional().describe(PLAINTEXT_OK_HELP),
      },
    },
    (args) =>
      tool(async () => {
        const input = parse(CreateEntryRequest, {
          ...(args.circle !== undefined ? { circle: args.circle } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.when !== undefined ? { when: args.when } : {}),
          ...(args.variants !== undefined
            ? {
                variants: args.variants.map((v) => ({
                  ...(v.when !== undefined ? { when: v.when } : {}),
                  content: v.content,
                  ...(v.sort_order !== undefined ? { sortOrder: v.sort_order } : {}),
                })),
              }
            : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.glossary !== undefined ? { glossary: args.glossary } : {}),
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
          ...(args.plaintext_ok ? { plaintextOk: true } : {}),
        })
        return withPlaintextReminder(await entries.create(input), args.plaintext_ok)
      }),
  )

  server.registerTool(
    'kioku_update',
    {
      description:
        '修改已有词条（改主题或切面不改变短 ID）：修改前先用 kioku_get 读取正文与版本号，带上 expected_version 防并发覆盖。' +
        '支持三种变体编辑方式（互斥）：① content + 可选 when 更新单个切片；② upsert_variants / remove_variant_whens 增量增删切片；③ variants 整组替换。整条词条至少保留 1 个切片。' +
        PLAINTEXT_TOOL_HELP +
        '原来就有的疑似明文不挡修改。',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .describe('要修改的词条短 ID（m-xxxxxx）、旧版坐标或精确标题'),
        circle: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .optional()
          .describe('精确标题遇到重名时限定目标记忆圈'),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
        title: z.string().trim().min(1).max(ENTRY_TITLE_MAX).optional().describe(TITLE_HELP),
        content: z.string().min(1).max(ENTRY_CONTENT_MAX).optional().describe('单切片更新正文'),
        when: McpWhen.optional().describe('配合 content 更新指定切面的单个切片，默认 {}'),
        variants: z
          .array(McpVariant)
          .min(1)
          .max(VARIANTS_MAX)
          .optional()
          .describe('整组替换该词条的全部变体切片'),
        upsert_variants: z
          .array(McpVariant)
          .min(1)
          .max(VARIANTS_MAX)
          .optional()
          .describe('增量新增或按切面条件覆盖多个切片'),
        remove_variant_whens: z
          .array(McpWhen)
          .min(1)
          .max(VARIANTS_MAX)
          .optional()
          .describe('按切面条件移除不再需要的切片'),
        topics: z
          .array(z.string().trim().min(1).max(64))
          .max(TOPICS_MAX)
          .optional()
          .describe('整组替换主题标签'),
        disclosure: z.string().trim().max(DISCLOSURE_MAX).nullable().optional(),
        priority: z.number().int().min(0).max(99).optional(),
        sensitivity: McpSensitivity.optional().describe(
          '敏感级：public / internal / private / secret；个人圈默认 private，共享圈默认 internal',
        ),
        glossary_add: z.array(z.string().trim().min(2).max(64)).max(GLOSSARY_MAX).optional(),
        glossary_remove: z.array(z.string().trim().min(1).max(64)).max(GLOSSARY_MAX).optional(),
        valid_to: z
          .string()
          .nullable()
          .optional()
          .describe(`${VALID_TO_HELP}；填 null 清掉，一直有效`),
        plaintext_ok: z.boolean().optional().describe(PLAINTEXT_OK_HELP),
      },
    },
    (args) =>
      tool(async () => {
        const input = parse(UpdateEntryRequest, {
          id: args.id,
          ...(args.circle !== undefined ? { circle: args.circle } : {}),
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.when !== undefined ? { when: args.when } : {}),
          ...(args.variants !== undefined
            ? {
                variants: args.variants.map((v) => ({
                  ...(v.when !== undefined ? { when: v.when } : {}),
                  content: v.content,
                  ...(v.sort_order !== undefined ? { sortOrder: v.sort_order } : {}),
                })),
              }
            : {}),
          ...(args.upsert_variants !== undefined
            ? {
                upsertVariants: args.upsert_variants.map((v) => ({
                  ...(v.when !== undefined ? { when: v.when } : {}),
                  content: v.content,
                  ...(v.sort_order !== undefined ? { sortOrder: v.sort_order } : {}),
                })),
              }
            : {}),
          ...(args.remove_variant_whens !== undefined
            ? { removeVariantWhens: args.remove_variant_whens }
            : {}),
          ...(args.topics !== undefined ? { topics: args.topics } : {}),
          ...(args.disclosure !== undefined ? { disclosure: args.disclosure } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.sensitivity !== undefined ? { sensitivity: args.sensitivity } : {}),
          ...(args.glossary_add !== undefined ? { glossaryAdd: args.glossary_add } : {}),
          ...(args.glossary_remove !== undefined ? { glossaryRemove: args.glossary_remove } : {}),
          ...(args.valid_to !== undefined ? { validTo: args.valid_to } : {}),
          ...(args.plaintext_ok ? { plaintextOk: true } : {}),
        })
        return withPlaintextReminder(
          await entries.update(input, 'kioku_update'),
          args.plaintext_ok,
          { requestedId: args.id },
        )
      }),
  )

  server.registerTool(
    'kioku_delete',
    {
      description:
        '软删除整条词条（含其下所有切片）。短 ID 与历史事件会保留，必要时可在管理界面恢复。',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .describe('要删除的词条短 ID（m-xxxxxx）、旧版坐标或精确标题'),
        circle: z.string().trim().min(1).max(64).optional().describe('限定所在记忆圈'),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
      },
      annotations: { destructiveHint: true },
    },
    (args) =>
      tool(async () => {
        const input = parse(DeleteEntryRequest, {
          id: args.id,
          ...(args.circle !== undefined ? { circle: args.circle } : {}),
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
        })
        const deleted = await entries.remove({
          id: input.id,
          ...(input.circle !== undefined ? { circle: input.circle } : {}),
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
        })
        return `已删除 ${deleted.shortId}`
      }),
  )

  server.registerTool(
    'kioku_transfer',
    {
      description:
        '把一条正式词条（entry）跨记忆圈迁移，迁移后保留原短 ID m-xxxxxx。' +
        '访问密钥仅限在两个都有写权限的共享圈之间迁移；个人圈与共享圈之间的互转请在管理界面操作。',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .max(2048)
          .describe('要迁移的词条短 ID（m-xxxxxx）、旧版坐标或精确标题'),
        from_circle: z.string().trim().min(1).max(64).optional().describe('源记忆圈标识'),
        to_circle: z.string().trim().min(1).max(64).describe('目标共享记忆圈 slug 或 UUID'),
        expected_version: z.number().int().optional().describe('读取时看到的版本号'),
      },
    },
    (args) =>
      tool(async () => {
        const input = parse(TransferEntryRequest, {
          id: args.id,
          ...(args.from_circle !== undefined ? { fromCircle: args.from_circle } : {}),
          toCircle: args.to_circle,
          ...(args.expected_version !== undefined
            ? { expectedVersion: args.expected_version }
            : {}),
        })
        return formatEntry(await entries.transfer(input))
      }),
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
        '新建或修改凭据（要凭据能力为「管理」的访问密钥）。不给 expected_version 就是新建；' +
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

const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024

// 只对合规的 POST JSON initialize 请求预读取解析（避免提前吞下超大 body 或重复解析 JSON）；其余交给 transport 校验报错
async function parseMcpPostBody(request: Request): Promise<unknown> {
  if (request.method !== 'POST') return undefined
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) return undefined
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > MCP_MAX_BODY_BYTES) return undefined
  try {
    const buf = await request.clone().arrayBuffer()
    if (buf.byteLength > MCP_MAX_BODY_BYTES) return undefined
    return JSON.parse(new TextDecoder().decode(buf))
  } catch {
    return undefined
  }
}

// 只在单条 initialize 握手时附带 MCP instructions：平时 tools/call 与非法批处理请求不额外查设置表
async function mcpInstructions(
  scope: RecallScope,
  parsedBody: unknown,
): Promise<string | undefined> {
  const isInit =
    !Array.isArray(parsedBody) &&
    typeof parsedBody === 'object' &&
    parsedBody !== null &&
    (parsedBody as { method?: unknown }).method === 'initialize'
  if (!isInit) return undefined
  try {
    return guidanceFor(false, await scope.settings())
  } catch (err) {
    console.warn('读取 MCP 使用指引的设置失败，退回默认指引', loggableError(err))
    return GUIDANCE
  }
}

// 无状态模式：每个请求一个服务器实例，不在进程里保存会话，方便多实例部署
export async function handleMcpRequest(
  entries: EntryService,
  scope: RecallScope,
  credentials: CredentialService,
  request: Request,
): Promise<Response> {
  const parsedBody = await parseMcpPostBody(request)
  const instructions = await mcpInstructions(scope, parsedBody)
  const server = buildMcpServer(entries, scope, credentials, instructions)
  // 不传 sessionIdGenerator 即无状态模式
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(
      request,
      parsedBody === undefined ? undefined : { parsedBody },
    )
  } finally {
    await server.close()
  }
}
