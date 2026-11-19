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
  existingImportClientsIn,
  hasConvertedImports,
  inPlanSnapshot,
  loreDataTimeIn,
  PLAN_CHANGED,
  planFingerprint,
  planImport,
  planImportFor,
  planSync,
  plaintextSpots,
  previewImport,
  resolveCirclesForImport,
  staleAgainst,
  type BasePlan,
  type CircleRef,
  type ExistingClient,
  type ImportOptions,
  type ImportPreview,
  type ImportTarget,
  type LoreSnapshot,
  type PlaintextConversion,
  type PlaintextSpot,
  type PlanSnapshot,
  type SyncPlan,
} from '../importer/lore'
import { parseLoreBackup, type ParsedLoreBackup } from '../importer/loreBackup'
import { fetchLoreBackup } from '../importer/loreFetch'
import { MemoryError } from '../memory/errors'

const params = z.object({ circleId: z.uuid() })
const errors = {
  400: jsonResponse('读不了来源（文件不对、Lore 连不上等）或计划有错误', ErrorResponse),
  403: jsonResponse('没有权限', ErrorResponse),
  413: jsonResponse('文件太大', ErrorResponse),
}

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
  path: '/circles/{circleId}/lore-import/plan',
  tags: ['console'],
  summary:
    '看从 Lore 导入的计划（只有记忆圈所有者，从地址拉取还要实例管理员）：每个节点写到哪、是新建还是已导入、同步差异，不含正文，不写库',
  middleware: uploadLimit(),
  request: { params, body: jsonBody(LoreImportPlanRequest) },
  responses: { 200: jsonResponse('导入计划', LoreImportPlan), ...errors },
})

const applyRoute = createRoute({
  method: 'post',
  path: '/circles/{circleId}/lore-import/apply',
  tags: ['console'],
  summary:
    '按看过的计划从 Lore 导入并同步（只有记忆圈所有者，从地址拉取还要实例管理员）：重新读来源、重新算计划，指纹不一致返回 409',
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

async function basePlan(
  snap: PlanSnapshot,
  snapshot: LoreSnapshot,
  targetCircles: { target: CircleRef; personal: CircleRef },
  existing: ExistingClient[],
  options: Pick<ImportOptions, 'accountId' | 'persona' | 'exportedAt'>,
  known: KnownCredentialValues | null,
): Promise<BasePlan & { preview: ImportPreview; sync: SyncPlan; fingerprint: string }> {
  const base = await planImportFor(snap, snapshot, targetCircles, existing, {
    ...options,
    secretUris: new Set(),
  })
  const preview = await previewImport(snap, base.plan, base.imports)
  const sync = await planSync(snap, base.plan, snapshot, base.imports, known)
  return { ...base, preview, sync, fingerprint: planFingerprint(base.plan, preview, sync) }
}

// 凭据现在的值从导入者的个人圈读取（凭据占位符只允许写在个人圈中），在事务与并发名额之外获取以免占着连接等密码库
async function knownValues(
  deps: Deps,
  target: Pick<ImportTarget, 'circleId' | 'personalCircleId'>,
  accountId: string,
  snapshot: LoreSnapshot,
): Promise<KnownCredentialValues | null> {
  const spotted = snapshot.nodes.some((n) => looksLikePlaintextCredential(n.content ?? ''))
  if (!spotted && !(await hasConvertedImports(deps.db, target))) return null
  return (await credentialServiceForConsole(deps, target.personalCircleId, accountId)).knownValues()
}

function spotsOf(
  snapshot: LoreSnapshot,
  known: KnownCredentialValues | null,
): Map<string, PlaintextSpot[]> {
  return new Map(snapshot.nodes.map((n) => [n.uuid, plaintextSpots(n.content, known)]))
}

export function conversionsOf(
  snapshot: LoreSnapshot,
  known: KnownCredentialValues | null,
  wanted: { source: string; index: number; credentialId: string; field: string }[],
): Map<string, PlaintextConversion[]> {
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
    clients: plan.clients,
    clientsGivenPersona: preview.clientsGivenPersona,
    clientsOtherPersona: preview.clientsOtherPersona,
    nodes: snapshot.nodes.flatMap((node) => {
      const targets = targetsOf.get(node.uri)
      if (!targets) return []
      return [
        {
          uuid: node.uuid,
          uri: node.uri,
          aliases: node.aliases,
          targets: targets.map(({ item, state, current }) => ({
            legacyUri: item.legacyUri,
            targetCircleKind: item.targetCircleKind,
            targetCircleId: item.targetCircleId,
            title: item.title,
            topics: item.topics,
            when: item.when,
            sensitivity: item.sensitivity,
            priority: item.priority,
            state,
            boot: item.boot,
            current,
          })),
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
    skipped: plan.skipped.map(({ source, reason }) => ({ source, reason })),
    droppedKeywords: plan.droppedKeywords,
    warnings: plan.warnings,
    sync: {
      items: sync.items.map(
        ({ source, legacyUri, shortId, title, state, target, reason, changes }) => ({
          source,
          legacyUri,
          shortId,
          title,
          state,
          changes,
          ...(target ? { target } : {}),
          ...(reason ? { reason } : {}),
        }),
      ),
      goneFromLore: sync.goneFromLore,
    },
  }
}

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

async function assertOwner(deps: Deps, circleId: string, accountId: string): Promise<void> {
  const role = await memberRole(deps, circleId, accountId)
  if (!role) throw new MemoryError(403, '无权访问此记忆圈')
  if (role !== 'owner') throw new MemoryError(403, '仅记忆圈所有者可从 Lore 导入')
}

export function loreImportRoutes(deps: Deps) {
  return router()
    .openapi(planRoute, async (c) => {
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      await assertOwner(deps, circleId, accountId)
      const { source, targetCircleId, persona = LORE_DEFAULT_PERSONA } = c.req.valid('json')
      const effectiveCircleId = targetCircleId ?? circleId
      if (effectiveCircleId !== circleId) await assertOwner(deps, effectiveCircleId, accountId)
      const parsed = await readSource(deps, accountId, source, c.req.raw.signal)
      const targetCircles = await resolveCirclesForImport(deps.db, accountId, effectiveCircleId)
      const target: ImportTarget = {
        db: deps.db,
        circleId: targetCircles.target.id,
        personalCircleId: targetCircles.personal.id,
        accountId,
        masterKey: deps.masterKey,
      }
      const known = await knownValues(deps, target, accountId, parsed.snapshot)
      const { base, dataTime } = await inPlanSnapshot(target, async (snap) => {
        const existing = await existingImportClientsIn(snap.tx, targetCircles.target.id)
        const base = await basePlan(
          snap,
          parsed.snapshot,
          targetCircles,
          existing,
          { accountId, persona, exportedAt: parsed.exportedAt },
          known,
        )
        const dataTime = source.kind === 'file' ? await loreDataTimeIn(snap.tx) : null
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
      const { circleId } = c.req.valid('param')
      const accountId = c.get('console').accountId
      await assertOwner(deps, circleId, accountId)
      const body = c.req.valid('json')
      const { source, targetCircleId, persona = LORE_DEFAULT_PERSONA } = body
      const effectiveCircleId = targetCircleId ?? circleId
      if (effectiveCircleId !== circleId) await assertOwner(deps, effectiveCircleId, accountId)
      const { snapshot, exportedAt } = await readSource(deps, accountId, source, c.req.raw.signal)
      const targetCircles = await resolveCirclesForImport(deps.db, accountId, effectiveCircleId)
      const target: ImportTarget = {
        db: deps.db,
        circleId: targetCircles.target.id,
        personalCircleId: targetCircles.personal.id,
        accountId,
        masterKey: deps.masterKey,
      }
      const options = { accountId, persona, exportedAt }
      const known = await knownValues(deps, target, accountId, snapshot)
      return withTransferSlot(accountId, c.req.raw.signal, async () => {
        const { plan, sync, imports } = await inPlanSnapshot(target, async (snap) => {
          const existing = await existingImportClientsIn(snap.tx, targetCircles.target.id)
          const base = await basePlan(snap, snapshot, targetCircles, existing, options, known)
          if (base.fingerprint !== body.fingerprint) throw new MemoryError(409, PLAN_CHANGED)
          const convert = conversionsOf(snapshot, known, body.convertPlaintext)
          const ticked = body.secretUris.length > 0 || body.excludeUris.length > 0
          const plan =
            ticked || convert.size
              ? planImport(snapshot, targetCircles, existing, {
                  ...options,
                  secretUris: new Set(body.secretUris),
                  excludeUris: new Set(body.excludeUris),
                  convert,
                })
              : base.plan
          assertExecutable(plan, deps.masterKey)
          const sync = ticked
            ? await planSync(snap, plan, snapshot, base.imports, known)
            : base.sync
          if (source.kind === 'file' && !body.confirmStale) {
            const preview = ticked ? await previewImport(snap, plan, base.imports) : base.preview
            const stale = staleAgainst(exportedAt, await loreDataTimeIn(snap.tx), preview, sync)
            if (stale) {
              throw new MemoryError(
                409,
                '此文件比记忆圈已写入的数据旧，写入会把内容改回旧版本，确认后才能执行',
              )
            }
          }
          return { plan, sync, imports: base.imports }
        })
        try {
          const result = await applyImport(target, plan, imports)
          const synced = await applySync(target, sync)
          return c.json({ ...result, sync: synced }, 200)
        } catch (err) {
          if (err instanceof MemoryError) throw err
          console.error('从 Lore 导入时出错', {
            code: pgErrorCode(err) ?? (err instanceof Error ? err.name : 'unknown'),
            cause: pgCauseCode(err),
          })
          return c.json({ error: '写入中途出错，可能已写入一部分' }, 500)
        } finally {
          void deps.jobs?.enqueueBackfill()
        }
      })
    })
}
