import { createRoute, z } from '@hono/zod-openapi'
import {
  ErrorResponse,
  LORE_DEFAULT_PERSONA,
  LORE_UPLOAD_MAX_BYTES,
  LoreImportApplyRequest,
  LoreImportPlan,
  LoreImportPlanRequest,
  LoreImportResult,
  type LoreImportSource,
} from '@kioku/contracts'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { isInstanceAdmin, memberRole } from '../auth/middleware'
import { withTransferSlot } from '../backup/transferGate'
import { placeholderIdentifiers } from '../credential/placeholders'
import { pgErrorCode } from '../db/client'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import {
  applyImport,
  applySync,
  assertExecutable,
  credentialHints,
  existingImportApps,
  loreDataTime,
  planFingerprint,
  planImport,
  planSync,
  previewImport,
  staleAgainst,
  type ExistingApp,
  type ImportOptions,
  type ImportPlan,
  type ImportPreview,
  type ImportTarget,
  type LoreSnapshot,
  type SyncPlan,
} from '../importer/lore'
import { parseLoreBackup, type ParsedLoreBackup } from '../importer/loreBackup'
import { fetchLoreBackup } from '../importer/loreFetch'
import { bootEligible } from '../memory/filter'
import { MemoryError } from '../memory/service'
import { DEFAULT_SENSITIVITY } from '../memory/uri'

const params = z.object({ spaceId: z.uuid() })
const errors = {
  400: jsonResponse('读不了来源（文件不对、Lore 连不上等）或计划有错误', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  413: jsonResponse('文件太大', ErrorResponse),
}

// 请求体的上限：校验器先读完请求体才到处理函数，所以这个上限要放在路由的中间件里。
// 处理函数里才查角色：有了上限内存就有界。上限只防一个请求，同时上传的个数现在不另外限制（账号只有一个）
function uploadLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: LORE_UPLOAD_MAX_BYTES + 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: `请求超过 ${LORE_UPLOAD_MAX_BYTES / 1024 / 1024} MB 的上限：上传的导出只留要用的五张表，确认文件是 Lore 的导出`,
        },
        413,
      ),
  })
}

const planRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/lore-import/plan',
  tags: ['console'],
  summary:
    '看从 Lore 导入的计划（只有空间 owner，从地址拉取还要实例管理员）：每个节点写到哪、是新建还是已导入、同步差异，不含正文，不写库',
  middleware: uploadLimit(),
  request: { params, body: jsonBody(LoreImportPlanRequest) },
  responses: { 200: jsonResponse('导入计划', LoreImportPlan), ...errors },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/spaces/{spaceId}/lore-import/apply',
  tags: ['console'],
  summary:
    '按看过的计划从 Lore 导入并同步（只有空间 owner，从地址拉取还要实例管理员）：重新读来源、重新算计划，指纹不一致返回 409',
  middleware: uploadLimit(),
  request: { params, body: jsonBody(LoreImportApplyRequest) },
  responses: {
    200: jsonResponse('导入与同步的结果', LoreImportResult),
    ...errors,
    409: jsonResponse('计划变了要重看，或者文件比已写入的数据旧而没有确认', ErrorResponse),
    429: jsonResponse('导出导入正忙，稍后再试', ErrorResponse),
    500: jsonResponse('写到一半出错，可能已写入一部分', ErrorResponse),
  },
})

// 不带勾选的基准计划：/plan 看的是它，/apply 重新算它来比指纹
async function basePlan(
  target: ImportTarget,
  snapshot: LoreSnapshot,
  existing: ExistingApp[],
  options: Pick<ImportOptions, 'accountId' | 'persona' | 'exportedAt'>,
): Promise<{ plan: ImportPlan; preview: ImportPreview; sync: SyncPlan; fingerprint: string }> {
  const plan = planImport(snapshot, existing, { ...options, secretUris: new Set() })
  const preview = await previewImport(target, plan)
  const sync = await planSync(target, plan, snapshot)
  return { plan, preview, sync, fingerprint: planFingerprint(plan, preview, sync) }
}

// 计划视图：只有元数据，没有正文（同步项的 request 与 context 里有正文，这里不带）
function planView(
  { snapshot, exportedAt }: ParsedLoreBackup,
  { plan, preview, sync, fingerprint }: Awaited<ReturnType<typeof basePlan>>,
  dataTime: Date | null,
  secretAvailable: boolean,
): LoreImportPlan {
  const targetsOf = new Map<string, ImportPreview['targets']>()
  for (const t of preview.targets) {
    targetsOf.set(t.item.source, [...(targetsOf.get(t.item.source) ?? []), t])
  }
  return {
    exportedAt,
    dataTime: dataTime?.toISOString() ?? null,
    staleSince: staleAgainst(exportedAt, dataTime, preview, sync)?.toISOString() ?? null,
    nodeCount: snapshot.nodes.length,
    previousVersions: snapshot.nodes.reduce((n, node) => n + node.previousVersions, 0),
    fingerprint,
    secretAvailable,
    persona: {
      ...plan.persona,
      exists: preview.personaExists,
      imported: preview.importedPersonas,
    },
    apps: plan.apps,
    appsGivenPersona: preview.appsGivenPersona,
    appsOtherPersona: preview.appsOtherPersona,
    nodes: snapshot.nodes.flatMap((node) => {
      const targets = targetsOf.get(node.uri)
      if (!targets) return []
      return [
        {
          uuid: node.uuid,
          uri: node.uri,
          aliases: node.aliases,
          targets: targets.map(({ item, state, current }) => {
            const layer = item.request.layer!
            return {
              uri: item.request.uri,
              layer,
              sensitivity: item.request.sensitivity ?? DEFAULT_SENSITIVITY[layer],
              priority: item.request.priority,
              state,
              boot: bootEligible(layer, item.request.priority),
              current,
            }
          }),
          credentialRefs: [...placeholderIdentifiers(node.content ?? '')].sort(),
          credentialHints: credentialHints(node),
        },
      ]
    }),
    skipped: plan.skipped,
    droppedKeywords: plan.droppedKeywords,
    warnings: plan.warnings,
    sync: {
      items: sync.items.map(({ source, uri, state, target, reason, changes }) => ({
        source,
        uri,
        state,
        changes,
        ...(target ? { target } : {}),
        ...(reason ? { reason } : {}),
      })),
      goneFromLore: sync.goneFromLore,
    },
  }
}

// 读来源。拉取由服务端向任意地址发请求，只给实例管理员；读全量，解析之后立刻丢弃，只留下要用的
async function readSource(
  deps: Deps,
  accountId: string,
  source: LoreImportSource,
  signal: AbortSignal,
): Promise<ParsedLoreBackup> {
  if (source.kind === 'file') return parseLoreBackup(source.backup)
  if (!(await isInstanceAdmin(deps.db, accountId))) {
    throw new MemoryError(403, '只有实例管理员能从地址拉取：服务端要向这个地址发请求')
  }
  return parseLoreBackup(await fetchLoreBackup(source, signal))
}

async function assertOwner(deps: Deps, spaceId: string, accountId: string): Promise<void> {
  const role = await memberRole(deps, spaceId, accountId)
  if (!role) throw new MemoryError(403, '不是该空间成员')
  // 导入要写 secret、新建人格和应用，和命令行一样要空间 owner
  if (role !== 'owner') throw new MemoryError(403, '只有空间 owner 能从 Lore 导入')
}

export function loreImportRoutes(deps: Deps) {
  return router()
    .openapi(planRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      await assertOwner(deps, spaceId, accountId)
      const { source, persona = LORE_DEFAULT_PERSONA } = c.req.valid('json')
      const parsed = await readSource(deps, accountId, source, c.req.raw.signal)
      const target = { db: deps.db, spaceId, accountId, masterKey: deps.masterKey }
      const existing = await existingImportApps(deps.db, spaceId)
      const base = await basePlan(target, parsed.snapshot, existing, {
        accountId,
        persona,
        exportedAt: parsed.exportedAt,
      })
      // 拉取读的是现在的 Lore，不用判断新旧
      const dataTime = source.kind === 'file' ? await loreDataTime(deps.db, spaceId) : null
      return c.json(planView(parsed, base, dataTime, deps.masterKey !== null), 200)
    })
    .openapi(applyRoute, async (c) => {
      const { spaceId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      await assertOwner(deps, spaceId, accountId)
      const body = c.req.valid('json')
      const { source, persona = LORE_DEFAULT_PERSONA } = body
      // 读来源不占名额：Lore 慢的时候不挡别人的导出导入
      const { snapshot, exportedAt } = await readSource(deps, accountId, source, c.req.raw.signal)
      const target = { db: deps.db, spaceId, accountId, masterKey: deps.masterKey }
      const options = { accountId, persona, exportedAt }
      // 名额只占「算基准计划、比指纹、写入」这一段，两次执行不会交错。客户端断开也写完：
      // 导入可以重复执行，停在中间没有好处
      return withTransferSlot(accountId, c.req.raw.signal, async () => {
        const existing = await existingImportApps(deps.db, spaceId)
        const base = await basePlan(target, snapshot, existing, options)
        if (base.fingerprint !== body.fingerprint) {
          throw new MemoryError(409, '看过计划之后来源或这个空间有变化：要重新看计划')
        }
        const plan = planImport(snapshot, existing, {
          ...options,
          secretUris: new Set(body.secretUris),
          excludeUris: new Set(body.excludeUris),
        })
        assertExecutable(plan, deps.masterKey)
        const sync = await planSync(target, plan, snapshot)
        if (source.kind === 'file' && !body.confirmStale) {
          const preview = await previewImport(target, plan)
          const stale = staleAgainst(
            exportedAt,
            await loreDataTime(deps.db, spaceId),
            preview,
            sync,
          )
          if (stale) {
            throw new MemoryError(
              409,
              '这个文件比这个空间已写入的数据旧，写入会把内容改回去：确认之后才能执行',
            )
          }
        }
        try {
          const result = await applyImport(target, plan)
          const synced = await applySync(target, sync)
          return c.json({ ...result, sync: synced }, 200)
        } catch (err) {
          if (err instanceof MemoryError) throw err
          // 驱动的错误里带着 SQL 与参数，也就是节点的正文，不能交给全局的错误处理打进日志
          console.error('从 Lore 导入时出错', {
            code: pgErrorCode(err) ?? (err instanceof Error ? err.name : 'unknown'),
          })
          return c.json({ error: '写到一半出错了，可能已写入一部分' }, 500)
        } finally {
          // 向量只靠补齐：写了一半也要排，不看这次新建了多少（重试时前面的都按事件去重了）
          void deps.jobs?.enqueueBackfill()
        }
      })
    })
}
