import { createRoute, z } from '@hono/zod-openapi'
import {
  DEFAULT_SENSITIVITY,
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
import { credentialServiceForConsole } from '../credential/context'
import { looksLikePlaintextCredential, placeholderIdentifiers } from '../credential/placeholders'
import { isConvertibleValue, type KnownCredentialValues } from '../credential/service'
import { pgCauseCode, pgErrorCode } from '../db/client'
import type { AppEnv, Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import {
  applyImport,
  applySync,
  assertExecutable,
  credentialHints,
  existingImportApps,
  hasConvertedImports,
  inPlanSnapshot,
  loreDataTime,
  PLAN_CHANGED,
  planFingerprint,
  planImport,
  planImportFor,
  planSync,
  plaintextSpots,
  previewImport,
  requestLayer,
  staleAgainst,
  type BasePlan,
  type ExistingApp,
  type ImportOptions,
  type ImportPreview,
  type PlaintextConversion,
  type PlaintextSpot,
  type PlanSnapshot,
  type LoreSnapshot,
  type SyncPlan,
} from '../importer/lore'
import { parseLoreBackup, type ParsedLoreBackup } from '../importer/loreBackup'
import { fetchLoreBackup } from '../importer/loreFetch'
import { bootEligible } from '../memory/filter'
import { MemoryError } from '../memory/service'

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
          error: `请求超过 ${LORE_UPLOAD_MAX_BYTES / 1024 / 1024} MB 上限。上传的导出文件只需保留要用的五张表，并确认文件是 Lore 的导出。`,
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

// 不带勾选的基准计划：/plan 看的是它，/apply 重新算它来比指纹。按勾选重算时沿用它查到的占用与读到的导入记录
async function basePlan(
  snap: PlanSnapshot,
  snapshot: LoreSnapshot,
  existing: ExistingApp[],
  options: Pick<ImportOptions, 'accountId' | 'persona' | 'exportedAt'>,
  known: KnownCredentialValues | null,
): Promise<BasePlan & { preview: ImportPreview; sync: SyncPlan; fingerprint: string }> {
  const base = await planImportFor(snap, snapshot, existing, {
    ...options,
    secretUris: new Set(),
  })
  const preview = await previewImport(snap, base.plan, base.imports)
  const sync = await planSync(snap, base.plan, snapshot, base.imports, known)
  return { ...base, preview, sync, fingerprint: planFingerprint(base.plan, preview, sync) }
}

// 凭据现在的值：比对正文里的疑似明文、同步换过占位符的记忆都要用。要请求密码库，所以在出计划的快照之外、
// 每次出计划之前取一次；没有疑似明文、也没有换过占位符的导入时不取，不碰密码库
async function knownValues(
  deps: Deps,
  spaceId: string,
  accountId: string,
  snapshot: LoreSnapshot,
): Promise<KnownCredentialValues | null> {
  // 只要判断有没有：用同一条规则的布尔版本，不在这里把每处都找出来（spotsOf 才逐处扫，每个节点扫一次）
  const spotted = snapshot.nodes.some((n) => looksLikePlaintextCredential(n.content ?? ''))
  if (!spotted && !(await hasConvertedImports(deps.db, spaceId))) return null
  return (await credentialServiceForConsole(deps, spaceId, accountId)).knownValues()
}

// 每个节点正文里的疑似明文与对上的凭据：节点 uuid → 各处（含值，只在服务端里用）
function spotsOf(
  snapshot: LoreSnapshot,
  known: KnownCredentialValues | null,
): Map<string, PlaintextSpot[]> {
  return new Map(snapshot.nodes.map((n) => [n.uuid, plaintextSpots(n.content, known)]))
}

// 要换成占位符的几处：按 Lore 的 URI（别名也算）找到节点，按 index 找到那一处，对不上节点或那一处时 400
// （调用方先比过指纹，来源变了的已经是 409）。只核对计划里显示的那条凭据（credentialId 与 field）这个字段现在的值
// （known 是写入之前刚取的）：还等于这一处的值才换成它的占位符，否则照原样写，不改去换成别的同值凭据，见 PlaintextConversion
export function conversionsOf(
  snapshot: LoreSnapshot,
  known: KnownCredentialValues | null,
  wanted: { source: string; index: number; credentialId: string; field: string }[],
): Map<string, PlaintextConversion[]> {
  // 只扫点到的节点，同一个节点扫一次：这一段在计划快照里、占着导入导出的名额
  const spots = new Map<string, PlaintextSpot[]>()
  const spotsIn = (node: LoreSnapshot['nodes'][number]) => {
    let found = spots.get(node.uuid)
    if (!found) {
      found = plaintextSpots(node.content, null)
      spots.set(node.uuid, found)
    }
    return found
  }
  const nodeByUri = new Map<string, LoreSnapshot['nodes'][number]>()
  for (const node of snapshot.nodes) {
    nodeByUri.set(node.uri, node)
    for (const alias of node.aliases) nodeByUri.set(alias, node)
  }
  const out = new Map<string, PlaintextConversion[]>()
  const problems: string[] = []
  for (const { source, index, credentialId, field } of wanted) {
    const node = nodeByUri.get(source)
    const spot = node ? spotsIn(node)[index] : undefined
    if (!node) {
      problems.push(`要换成占位符的 ${source} 在 Lore 中不存在`)
      continue
    }
    if (!spot) {
      problems.push(`${source} 的正文中没有第 ${index + 1} 处疑似明文`)
      continue
    }
    const list = out.get(node.uuid) ?? []
    if (list.some((c) => c.value === spot.value && c.line === spot.line)) continue
    const entry = known?.entries.find((e) => e.id === credentialId && e.field === field)
    const base = { line: spot.line, value: spot.value }
    list.push(
      !isConvertibleValue(spot.value)
        ? { ...base, credential: null, problem: 'unconvertible' }
        : entry && entry.value === spot.value
          ? { ...base, credential: { identifier: entry.identifier, field: entry.field } }
          : { ...base, credential: null, problem: 'stale' },
    )
    out.set(node.uuid, list)
  }
  if (problems.length) {
    throw new MemoryError(400, `计划有误，无法执行：${[...new Set(problems)].join('；')}`)
  }
  return out
}

// 计划视图：只有元数据，没有正文（同步项的 request 与 context 里有正文，这里不带）。疑似明文只给位置、类别与对上的凭据
function planView(
  { snapshot, exportedAt }: ParsedLoreBackup,
  { plan, preview, sync, fingerprint }: Awaited<ReturnType<typeof basePlan>>,
  dataTime: Date | null,
  secretAvailable: boolean,
  spots: Map<string, PlaintextSpot[]>,
  known: KnownCredentialValues | null,
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
    credentialMatch: known && {
      unavailableConnections: known.unavailableConnections,
      unreadableCredentials: known.unreadableCredentials,
    },
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
            const layer = requestLayer(item.request)
            return {
              uri: item.request.uri,
              title: item.request.title ?? item.request.uri,
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
          plaintext: (spots.get(node.uuid) ?? []).map(({ index, line, kind, credential }) => ({
            index,
            line,
            kind,
            credential,
          })),
        },
      ]
    }),
    // 去重键只给同步用，不进视图
    skipped: plan.skipped.map(({ source, reason }) => ({ source, reason })),
    droppedKeywords: plan.droppedKeywords,
    warnings: plan.warnings,
    sync: {
      items: sync.items.map(({ source, uri, title, state, target, reason, changes }) => ({
        source,
        uri,
        title,
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
    throw new MemoryError(403, '仅实例管理员可从地址拉取：服务端会向此地址发送请求')
  }
  return parseLoreBackup(await fetchLoreBackup(source, signal))
}

async function assertOwner(deps: Deps, spaceId: string, accountId: string): Promise<void> {
  const role = await memberRole(deps, spaceId, accountId)
  if (!role) throw new MemoryError(403, '无权访问此空间')
  // 导入要写 secret、新建人格和应用，和命令行一样要空间 owner
  if (role !== 'owner') throw new MemoryError(403, '仅空间所有者可从 Lore 导入')
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
      const known = await knownValues(deps, spaceId, accountId, parsed.snapshot)
      // 已有应用、基准计划与数据时间都在出计划的同一个快照里读
      const { base, dataTime } = await inPlanSnapshot(target, async (snap) => {
        const existing = await existingImportApps(snap.db, spaceId)
        const base = await basePlan(
          snap,
          parsed.snapshot,
          existing,
          { accountId, persona, exportedAt: parsed.exportedAt },
          known,
        )
        // 拉取读的是现在的 Lore，不用判断新旧
        const dataTime = source.kind === 'file' ? await loreDataTime(snap.db, spaceId) : null
        return { base, dataTime }
      })
      return c.json(
        planView(
          parsed,
          base,
          dataTime,
          deps.masterKey !== null,
          spotsOf(parsed.snapshot, known),
          known,
        ),
        200,
      )
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
      // 凭据的值在占名额之前、事务之外重新取：要换的几处在这里再和凭据比一次，同步也按它
      const known = await knownValues(deps, spaceId, accountId, snapshot)
      // 名额只占「算基准计划、比指纹、写入」这一段，两次执行不会交错。客户端断开也写完：
      // 导入可以重复执行，停在中间没有好处
      return withTransferSlot(accountId, c.req.raw.signal, async () => {
        // 出计划的几步（基准计划、比指纹、按勾选重算、判断新旧）在同一个只读快照里，写入在快照之外
        const { plan, sync, imports } = await inPlanSnapshot(target, async (snap) => {
          const existing = await existingImportApps(snap.db, spaceId)
          const base = await basePlan(snap, snapshot, existing, options, known)
          if (base.fingerprint !== body.fingerprint) throw new MemoryError(409, PLAN_CHANGED)
          // 指纹之后才查要换的几处：来源变了、那一处没了的先报计划变了
          const convert = conversionsOf(snapshot, known, body.convertPlaintext)
          // 没有勾选时要执行的就是基准计划，不用占着名额再算一遍。有勾选时沿用基准计划查到的占用，不再查：
          // 写入的才是看过的计划减去勾掉的（之后才被占用的由写入时的数据库判断）
          const ticked = body.secretUris.length > 0 || body.excludeUris.length > 0
          // 换占位符只改新建时写的正文（PlannedMemory.converted），预览、同步与新旧的判断都不受它影响
          const plan =
            ticked || convert.size
              ? planImport(snapshot, existing, {
                  ...options,
                  secretUris: new Set(body.secretUris),
                  excludeUris: new Set(body.excludeUris),
                  occupied: base.occupied,
                  convert,
                })
              : base.plan
          assertExecutable(plan, deps.masterKey)
          const sync = ticked
            ? await planSync(snap, plan, snapshot, base.imports, known)
            : base.sync
          if (source.kind === 'file' && !body.confirmStale) {
            const preview = ticked ? await previewImport(snap, plan, base.imports) : base.preview
            const stale = staleAgainst(
              exportedAt,
              await loreDataTime(snap.db, spaceId),
              preview,
              sync,
            )
            if (stale) {
              throw new MemoryError(
                409,
                '此文件比空间已写入的数据旧，写入会把内容改回旧版本，确认后才能执行',
              )
            }
          }
          return { plan, sync, imports: base.imports }
        })
        try {
          // 写入事务里重读导入记录，和出计划时的不一致（之间别处又导入过）就返回 409，见 applyImport
          const result = await applyImport(target, plan, imports)
          const synced = await applySync(target, sync)
          return c.json({ ...result, sync: synced }, 200)
        } catch (err) {
          if (err instanceof MemoryError) throw err
          // 驱动的错误里带着 SQL 与参数，也就是节点的正文，不能交给全局的错误处理打进日志
          console.error('从 Lore 导入时出错', {
            code: pgErrorCode(err) ?? (err instanceof Error ? err.name : 'unknown'),
            cause: pgCauseCode(err),
          })
          return c.json({ error: '写入中途出错，可能已写入一部分' }, 500)
        } finally {
          // 向量只靠补齐：写了一半也要排，不看这次新建了多少（重试时前面的都按事件去重了）
          void deps.jobs?.enqueueBackfill()
        }
      })
    })
}
