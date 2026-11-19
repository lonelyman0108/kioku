import {
  BUILTIN_FACET_DIMENSIONS,
  BUILTIN_FACET_KEYS,
  FACET_TERM_SLUG_PATTERN,
  MAX_CUSTOM_FACET_DIMENSIONS,
  MAX_FACET_IMPLIES_DEPTH,
  isBuiltinFacetKey,
  normalizeWhen,
  type CreateFacetDimensionRequest,
  type CreateFacetTermRequest,
  type DefaultFacets,
  type FacetDimensionView,
  type FacetMatchMode,
  type FacetTermView,
  type FacetVocabularyView,
  type FlippedTerm,
  type LifecycleProject,
  type UpdateFacetDimensionRequest,
  type UpdateFacetTermRequest,
  type WhenCondition,
} from '@kioku/contracts'
import { and, asc, eq, inArray } from 'drizzle-orm'

import type { Access } from '../access/access'
import { expandWhenImplies, type FacetTermImplies } from '../access/realms'
import { isUniqueViolation, type Tx } from '../db/client'
import { circles, facetDimensions, facetTerms } from '../db/schema'
import { MemoryError } from './errors'
import { isRestrictedChatAccess } from './links'

const ASCII_WORD_CHAR = /^[a-z0-9_-]$/

export interface FacetTermRecord extends FacetTermImplies {
  id: string
  circleId: string
  label: string
  aliases: string[]
  autoRegistered: boolean
}

export interface CircleVocabulary {
  circleId: string
  defaultFacets: DefaultFacets
  dimensions: Map<string, FacetMatchMode>
  dimensionNames: Map<string, string>
  terms: FacetTermRecord[]
}

export interface VariantEvaluation {
  effectiveWhen: Record<string, string[]>
  kHit: number
  kConf: number
  hasConflict: boolean
  explicitDims: number
  delta: number
}

export interface FlippedFocusResult {
  queryFocus: WhenCondition
  flippedTerms: FlippedTerm[]
  flippedCircleIds: Set<string>
  flippedRealms: Set<string>
}

function toDimensionView(row: typeof facetDimensions.$inferSelect): FacetDimensionView {
  return {
    key: row.key,
    name: row.name,
    matchMode: row.matchMode,
    builtin: false,
    autoRegister: false,
    description: row.description ?? null,
  }
}

function toTermView(row: typeof facetTerms.$inferSelect): FacetTermView {
  return {
    id: row.id,
    circleId: row.circleId,
    dimensionKey: row.dimensionKey,
    slug: row.slug,
    label: row.label,
    implies: normalizeWhen(row.implies),
    aliases: [...row.aliases],
    autoRegistered: row.autoRegistered,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function dedupeAliases(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const clean = item.trim()
    const key = clean.toLowerCase()
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

async function knownDimensionKeys(tx: Tx, circleId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ key: facetDimensions.key })
    .from(facetDimensions)
    .where(eq(facetDimensions.circleId, circleId))
  return new Set<string>([...BUILTIN_FACET_KEYS, ...rows.map((r) => r.key)])
}

// 校验切面词条蕴含关系有向无环且最长路径边数不超过 MAX_FACET_IMPLIES_DEPTH
function assertAcyclicImplies(
  existing: readonly { id: string; dimensionKey: string; slug: string; implies: WhenCondition }[],
  candidate: { id?: string; dimensionKey: string; slug: string; implies: WhenCondition },
): void {
  const adj = new Map<string, string[]>()
  const nodeKey = (dim: string, slug: string) =>
    `${dim.trim().toLowerCase()}\0${slug.trim().toLowerCase()}`
  const setEdges = (dim: string, slug: string, implies: WhenCondition) => {
    const edges: string[] = []
    for (const [impDim, impSlugs] of Object.entries(normalizeWhen(implies))) {
      for (const impSlug of impSlugs) {
        edges.push(nodeKey(impDim, impSlug))
      }
    }
    adj.set(nodeKey(dim, slug), edges)
  }

  for (const item of existing) {
    if (candidate.id && item.id === candidate.id) continue
    setEdges(item.dimensionKey, item.slug, item.implies)
  }
  setEdges(candidate.dimensionKey, candidate.slug, candidate.implies)

  const state = new Map<string, 0 | 1 | 2>()
  const depthMemo = new Map<string, number>()

  const dfs = (node: string): number => {
    const s = state.get(node) ?? 0
    if (s === 1) throw new MemoryError(400, '切面蕴含关系不能成环')
    if (s === 2) return depthMemo.get(node) ?? 0
    state.set(node, 1)
    let longest = 0
    for (const next of adj.get(node) ?? []) {
      const childDepth = dfs(next)
      if (childDepth + 1 > longest) longest = childDepth + 1
    }
    state.set(node, 2)
    depthMemo.set(node, longest)
    if (longest > MAX_FACET_IMPLIES_DEPTH) {
      throw new MemoryError(400, `切面蕴含层级不能超过 ${MAX_FACET_IMPLIES_DEPTH} 层`)
    }
    return longest
  }

  for (const node of adj.keys()) {
    dfs(node)
  }
}

export async function listVocabulary(tx: Tx, circleId: string): Promise<FacetVocabularyView> {
  const [dims, terms] = await Promise.all([
    tx
      .select()
      .from(facetDimensions)
      .where(eq(facetDimensions.circleId, circleId))
      .orderBy(asc(facetDimensions.key)),
    tx
      .select()
      .from(facetTerms)
      .where(eq(facetTerms.circleId, circleId))
      .orderBy(asc(facetTerms.dimensionKey), asc(facetTerms.slug)),
  ])
  const builtinDims: FacetDimensionView[] = BUILTIN_FACET_KEYS.map((key) => {
    const meta = BUILTIN_FACET_DIMENSIONS[key]
    return {
      key: meta.key,
      name: meta.name,
      matchMode: meta.matchMode,
      builtin: true,
      autoRegister: meta.autoRegister,
      description: meta.description,
    }
  })
  return {
    circleId,
    dimensions: [...builtinDims, ...dims.map(toDimensionView)],
    terms: terms.map(toTermView),
  }
}

export async function createDimension(
  tx: Tx,
  circleId: string,
  input: CreateFacetDimensionRequest,
): Promise<FacetDimensionView> {
  if (isBuiltinFacetKey(input.key)) {
    throw new MemoryError(400, `不能使用内置维度键名：${input.key}`)
  }
  const existing = await tx
    .select({ key: facetDimensions.key })
    .from(facetDimensions)
    .where(eq(facetDimensions.circleId, circleId))
  if (existing.some((d) => d.key === input.key)) {
    throw new MemoryError(409, `切面维度已存在：${input.key}`)
  }
  if (existing.length >= MAX_CUSTOM_FACET_DIMENSIONS) {
    throw new MemoryError(400, `每个记忆圈最多创建 ${MAX_CUSTOM_FACET_DIMENSIONS} 个自定义维度`)
  }
  try {
    const [row] = await tx
      .insert(facetDimensions)
      .values({
        circleId,
        key: input.key,
        name: input.name,
        matchMode: input.matchMode,
        description: input.description,
      })
      .returning()
    return toDimensionView(row!)
  } catch (err) {
    if (isUniqueViolation(err, 'facet_dimensions_circle_key_idx')) {
      throw new MemoryError(409, `切面维度已存在：${input.key}`)
    }
    throw err
  }
}

export async function updateDimension(
  tx: Tx,
  circleId: string,
  key: string,
  input: UpdateFacetDimensionRequest,
): Promise<FacetDimensionView> {
  const cleanKey = key.trim().toLowerCase()
  if (isBuiltinFacetKey(cleanKey)) {
    throw new MemoryError(400, `内置维度 ${cleanKey} 不允许修改`)
  }
  const [before] = await tx
    .select()
    .from(facetDimensions)
    .where(and(eq(facetDimensions.circleId, circleId), eq(facetDimensions.key, cleanKey)))
    .limit(1)
  if (!before) throw new MemoryError(404, `未找到切面维度：${cleanKey}`)
  const [updated] = await tx
    .update(facetDimensions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.matchMode !== undefined ? { matchMode: input.matchMode } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    })
    .where(eq(facetDimensions.id, before.id))
    .returning()
  return toDimensionView(updated!)
}

export async function deleteDimension(tx: Tx, circleId: string, key: string): Promise<void> {
  const cleanKey = key.trim().toLowerCase()
  if (isBuiltinFacetKey(cleanKey)) {
    throw new MemoryError(400, `内置维度 ${cleanKey} 不允许删除`)
  }
  const [existing] = await tx
    .select({ id: facetDimensions.id })
    .from(facetDimensions)
    .where(and(eq(facetDimensions.circleId, circleId), eq(facetDimensions.key, cleanKey)))
    .limit(1)
  if (!existing) throw new MemoryError(404, `未找到切面维度：${cleanKey}`)

  const terms = await tx
    .select({
      dimensionKey: facetTerms.dimensionKey,
      implies: facetTerms.implies,
    })
    .from(facetTerms)
    .where(eq(facetTerms.circleId, circleId))
  for (const term of terms) {
    if (term.dimensionKey === cleanKey) continue
    if (normalizeWhen(term.implies)[cleanKey]?.length) {
      throw new MemoryError(409, '仍有其他切面词条的蕴含关系引用该维度，无法删除')
    }
  }
  await tx
    .delete(facetTerms)
    .where(and(eq(facetTerms.circleId, circleId), eq(facetTerms.dimensionKey, cleanKey)))
  await tx.delete(facetDimensions).where(eq(facetDimensions.id, existing.id))
}

export async function createTerm(
  tx: Tx,
  circleId: string,
  input: CreateFacetTermRequest,
): Promise<FacetTermView> {
  const dims = await knownDimensionKeys(tx, circleId)
  if (!dims.has(input.dimensionKey)) {
    throw new MemoryError(400, `未知切面维度：${input.dimensionKey}`)
  }
  const implies = normalizeWhen(input.implies)
  for (const impDim of Object.keys(implies)) {
    if (!dims.has(impDim)) {
      throw new MemoryError(400, `蕴含引用了未知切面维度：${impDim}`)
    }
  }
  const aliases = dedupeAliases(input.aliases)

  const allTerms = await tx.select().from(facetTerms).where(eq(facetTerms.circleId, circleId))
  const current = allTerms.find(
    (t) => t.dimensionKey === input.dimensionKey && t.slug === input.slug,
  )
  if (current && !current.autoRegistered) {
    throw new MemoryError(409, `该切面词条已存在：${input.dimensionKey}:${input.slug}`)
  }

  assertAcyclicImplies(allTerms, {
    ...(current ? { id: current.id } : {}),
    dimensionKey: input.dimensionKey,
    slug: input.slug,
    implies,
  })

  if (current) {
    const [upgraded] = await tx
      .update(facetTerms)
      .set({
        label: input.label,
        implies,
        aliases,
        autoRegistered: false,
        updatedAt: new Date(),
      })
      .where(eq(facetTerms.id, current.id))
      .returning()
    return toTermView(upgraded!)
  }

  try {
    const [created] = await tx
      .insert(facetTerms)
      .values({
        circleId,
        dimensionKey: input.dimensionKey,
        slug: input.slug,
        label: input.label,
        implies,
        aliases,
        autoRegistered: false,
      })
      .returning()
    return toTermView(created!)
  } catch (err) {
    if (isUniqueViolation(err, 'facet_terms_circle_dim_slug_idx')) {
      throw new MemoryError(409, `该切面词条已存在：${input.dimensionKey}:${input.slug}`)
    }
    throw err
  }
}

export async function updateTerm(
  tx: Tx,
  circleId: string,
  id: string,
  input: UpdateFacetTermRequest,
): Promise<FacetTermView> {
  const allTerms = await tx.select().from(facetTerms).where(eq(facetTerms.circleId, circleId))
  const current = allTerms.find((t) => t.id === id)
  if (!current) throw new MemoryError(404, '未找到切面词条')

  const implies = input.implies !== undefined ? normalizeWhen(input.implies) : current.implies
  if (input.implies !== undefined) {
    const dims = await knownDimensionKeys(tx, circleId)
    for (const impDim of Object.keys(implies)) {
      if (!dims.has(impDim)) {
        throw new MemoryError(400, `蕴含引用了未知切面维度：${impDim}`)
      }
    }
    assertAcyclicImplies(allTerms, {
      id: current.id,
      dimensionKey: current.dimensionKey,
      slug: current.slug,
      implies,
    })
  }
  const aliases = input.aliases !== undefined ? dedupeAliases(input.aliases) : current.aliases

  const [updated] = await tx
    .update(facetTerms)
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      implies,
      aliases,
      updatedAt: new Date(),
    })
    .where(and(eq(facetTerms.circleId, circleId), eq(facetTerms.id, id)))
    .returning()
  return toTermView(updated!)
}

export async function deleteTerm(tx: Tx, circleId: string, id: string): Promise<void> {
  const deleted = await tx
    .delete(facetTerms)
    .where(and(eq(facetTerms.circleId, circleId), eq(facetTerms.id, id)))
    .returning({ id: facetTerms.id })
  if (!deleted.length) throw new MemoryError(404, '未找到切面词条')
}

export function normalizeProjectSlug(project?: LifecycleProject): string | null {
  const raw = (project?.repoName ?? project?.dirName ?? '').trim().toLowerCase()
  if (!raw || raw.includes('{{cred:')) return null
  const slug = raw
    .replace(/[^a-z0-9._\-\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return FACET_TERM_SLUG_PATTERN.test(slug) ? slug : null
}

export async function ensureProjectTerm(
  tx: Tx,
  circleId: string,
  project?: LifecycleProject,
  canWrite = false,
): Promise<string | null> {
  const slug = normalizeProjectSlug(project)
  if (!slug) return null
  if (canWrite) {
    const rawLabel = (project?.repoName ?? project?.dirName ?? slug).trim().slice(0, 64)
    await tx
      .insert(facetTerms)
      .values({
        circleId,
        dimensionKey: 'project',
        slug,
        label: rawLabel || slug,
        implies: {},
        aliases: [],
        autoRegistered: true,
      })
      .onConflictDoNothing()
  }
  return slug
}

function addMapUnion(target: Map<string, Set<string>>, source: Map<string, Set<string>>): void {
  for (const [dim, slugs] of source) {
    let bucket = target.get(dim)
    if (!bucket) {
      bucket = new Set<string>()
      target.set(dim, bucket)
    }
    for (const s of slugs) bucket.add(s)
  }
}

function mapToWhen(map: Map<string, Set<string>>): WhenCondition {
  const raw: Record<string, string[]> = {}
  for (const [dim, slugs] of map) {
    if (slugs.size > 0) raw[dim] = [...slugs]
  }
  return normalizeWhen(raw)
}

function whenToMap(when: WhenCondition): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [dim, slugs] of Object.entries(normalizeWhen(when))) {
    if (slugs.length) out.set(dim, new Set(slugs))
  }
  return out
}

// 合成请求级动态存在感焦点 C（顺序：终端切面+客户端家族 -> 项目上下文及场域覆写 -> 主场圈兜底 -> 显式查询切面覆盖）
export function synthesizePresenceFocus(input: {
  contextFacets: WhenCondition
  runtimeFamily?: string
  projectSlug?: string | null
  explicitFacets?: WhenCondition
  primaryDefaultFacets?: DefaultFacets
  primaryTerms: readonly FacetTermImplies[]
}): WhenCondition {
  const base = normalizeWhen(input.contextFacets)
  const runtimeSlug = input.runtimeFamily?.trim().toLowerCase()
  if (runtimeSlug && FACET_TERM_SLUG_PATTERN.test(runtimeSlug)) {
    const prev = base.runtime ?? []
    if (!prev.includes(runtimeSlug)) base.runtime = [...prev, runtimeSlug]
  }

  const focus = expandWhenImplies(base, input.primaryTerms)

  if (input.projectSlug) {
    const projectExpanded = expandWhenImplies({ project: [input.projectSlug] }, input.primaryTerms)
    const projectRealms = projectExpanded.get('realm')
    if (projectRealms && projectRealms.size > 0) {
      focus.set('realm', new Set(projectRealms))
    }
    for (const [dim, slugs] of projectExpanded) {
      if (dim === 'realm') continue
      let bucket = focus.get(dim)
      if (!bucket) {
        bucket = new Set<string>()
        focus.set(dim, bucket)
      }
      for (const s of slugs) bucket.add(s)
    }
  }

  if (input.primaryDefaultFacets) {
    for (const [dim, slugs] of Object.entries(normalizeWhen(input.primaryDefaultFacets))) {
      if (focus.get(dim)?.size) continue
      const defExpanded = expandWhenImplies({ [dim]: slugs }, input.primaryTerms)
      for (const [d, impSlugs] of defExpanded) {
        if (!focus.get(d)?.size && impSlugs.size > 0) {
          focus.set(d, new Set(impSlugs))
        }
      }
    }
  }

  if (input.explicitFacets) {
    const cleanExplicit = normalizeWhen(input.explicitFacets)
    if (Object.keys(cleanExplicit).length > 0) {
      const expanded = expandWhenImplies(cleanExplicit, input.primaryTerms)
      for (const [dim, rawSlugs] of Object.entries(cleanExplicit)) {
        focus.set(dim, new Set(expanded.get(dim) ?? rawSlugs))
      }
      for (const [dim, slugs] of expanded) {
        if (dim in cleanExplicit) continue
        let bucket = focus.get(dim)
        if (!bucket) {
          bucket = new Set<string>()
          focus.set(dim, bucket)
        }
        for (const s of slugs) bucket.add(s)
      }
    }
  }

  return mapToWhen(focus)
}

export function aliasMatchesQuery(queryLower: string, rawAlias: string): boolean {
  const alias = rawAlias.trim().toLowerCase()
  if ([...alias].length < 2) return false
  const firstAscii = ASCII_WORD_CHAR.test(alias[0]!)
  const lastAscii = ASCII_WORD_CHAR.test(alias[alias.length - 1]!)
  let pos = 0
  while (pos <= queryLower.length - alias.length) {
    const idx = queryLower.indexOf(alias, pos)
    if (idx < 0) return false
    const leftOk = !firstAscii || idx === 0 || !ASCII_WORD_CHAR.test(queryLower[idx - 1]!)
    const after = idx + alias.length
    const rightOk =
      !lastAscii || after >= queryLower.length || !ASCII_WORD_CHAR.test(queryLower[after]!)
    if (leftOk && rightOk) return true
    pos = idx + 1
  }
  return false
}

// 提问破壁扫描：匹配可见圈词表触发词并追加合并到当轮查询焦点；受限会话跳过客场自动登记项目词条
export function scanQueryIntentFlipping(
  query: string,
  baseFocus: WhenCondition,
  access: Access,
  vocabularies: ReadonlyMap<string, CircleVocabulary>,
): FlippedFocusResult {
  const queryLower = query.toLowerCase()
  const restrictedChat = isRestrictedChatAccess(access)
  const focus = whenToMap(baseFocus)
  const flippedTerms: FlippedTerm[] = []
  const seenKeys = new Set<string>()
  const flippedCircleIds = new Set<string>()
  const flippedRealms = new Set<string>()

  const orderedCircleIds = [
    access.primaryCircleId,
    ...[...vocabularies.keys()].filter((id) => id !== access.primaryCircleId).sort(),
  ]

  for (const circleId of orderedCircleIds) {
    const vocab = vocabularies.get(circleId)
    if (!vocab) continue
    const terms = [...vocab.terms].sort(
      (a, b) => a.dimensionKey.localeCompare(b.dimensionKey) || a.slug.localeCompare(b.slug),
    )
    for (const term of terms) {
      if (
        restrictedChat &&
        circleId !== access.primaryCircleId &&
        term.dimensionKey === 'project' &&
        term.autoRegistered
      ) {
        continue
      }
      const matchedAlias = term.aliases.find((alias) => aliasMatchesQuery(queryLower, alias))
      if (!matchedAlias) continue

      const dedupKey = `${term.dimensionKey}\0${term.slug}`
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey)
        flippedTerms.push({
          dimensionKey: term.dimensionKey,
          slug: term.slug,
          label: term.label,
          alias: matchedAlias.trim(),
        })
      }
      flippedCircleIds.add(circleId)

      const expanded = expandWhenImplies({ [term.dimensionKey]: [term.slug] }, vocab.terms)
      addMapUnion(focus, expanded)
      for (const r of expanded.get('realm') ?? []) {
        flippedRealms.add(r)
      }
    }
  }

  return {
    queryFocus: mapToWhen(focus),
    flippedTerms,
    flippedCircleIds,
    flippedRealms,
  }
}

export function dimensionMatchMode(
  dim: string,
  customDimensions: ReadonlyMap<string, FacetMatchMode>,
): FacetMatchMode {
  if (isBuiltinFacetKey(dim)) return BUILTIN_FACET_DIMENSIONS[dim].matchMode
  return customDimensions.get(dim) ?? 'exclusive'
}

export function effectiveVariantWhen(
  when: WhenCondition,
  circleDefaults: DefaultFacets,
): Record<string, string[]> {
  return {
    ...normalizeWhen(circleDefaults),
    ...normalizeWhen(when),
  }
}

export function evaluateVariantFocus(input: {
  when: WhenCondition
  circleDefaults: DefaultFacets
  focus: WhenCondition
  customDimensions: ReadonlyMap<string, FacetMatchMode>
  awayCircle: boolean
  flippedCircle: boolean
  flippedRealms: ReadonlySet<string>
  crossGroup: boolean
}): VariantEvaluation {
  const effectiveWhen = effectiveVariantWhen(input.when, input.circleDefaults)
  const focus = normalizeWhen(input.focus)
  let kHit = 0
  let kConf = 0

  for (const [dim, slugs] of Object.entries(effectiveWhen)) {
    if (!slugs.length) continue
    const focusSlugs = focus[dim]
    if (focusSlugs?.length && slugs.some((s) => focusSlugs.includes(s))) {
      kHit++
    } else if (dimensionMatchMode(dim, input.customDimensions) === 'exclusive') {
      kConf++
    }
  }

  const awayFlipped =
    input.flippedCircle ||
    Boolean(effectiveWhen.realm?.some((realmSlug) => input.flippedRealms.has(realmSlug)))
  const awayPenalty = input.awayCircle && !awayFlipped ? 0.1 : 0
  const crossGroupPenalty = input.crossGroup ? 0.06 : 0
  const hitBonus = kHit > 0 ? Math.min(0.28, 0.16 * kHit + 0.06 * Math.max(0, kHit - 1)) : 0
  const confPenalty = kConf > 0 ? Math.min(0.32, 0.18 * kConf) : 0

  return {
    effectiveWhen,
    kHit,
    kConf,
    hasConflict: kConf > 0,
    explicitDims: Object.keys(normalizeWhen(input.when)).length,
    delta: hitBonus - confPenalty - awayPenalty - crossGroupPenalty,
  }
}

export async function loadCircleVocabularies(
  tx: Tx,
  circleIds: readonly string[],
): Promise<Map<string, CircleVocabulary>> {
  const uniqueIds = [...new Set(circleIds)]
  const out = new Map<string, CircleVocabulary>()
  if (!uniqueIds.length) return out

  const [circleRows, dimRows, termRows] = await Promise.all([
    tx
      .select({ id: circles.id, defaultFacets: circles.defaultFacets })
      .from(circles)
      .where(inArray(circles.id, uniqueIds)),
    tx
      .select({
        circleId: facetDimensions.circleId,
        key: facetDimensions.key,
        name: facetDimensions.name,
        matchMode: facetDimensions.matchMode,
      })
      .from(facetDimensions)
      .where(inArray(facetDimensions.circleId, uniqueIds)),
    tx
      .select({
        id: facetTerms.id,
        circleId: facetTerms.circleId,
        dimensionKey: facetTerms.dimensionKey,
        slug: facetTerms.slug,
        label: facetTerms.label,
        implies: facetTerms.implies,
        aliases: facetTerms.aliases,
        autoRegistered: facetTerms.autoRegistered,
      })
      .from(facetTerms)
      .where(inArray(facetTerms.circleId, uniqueIds)),
  ])

  for (const row of circleRows) {
    out.set(row.id, {
      circleId: row.id,
      defaultFacets: normalizeWhen(row.defaultFacets),
      dimensions: new Map(),
      dimensionNames: new Map(),
      terms: [],
    })
  }
  for (const d of dimRows) {
    const vocab = out.get(d.circleId)
    if (!vocab) continue
    vocab.dimensions.set(d.key, d.matchMode)
    vocab.dimensionNames.set(d.key, d.name)
  }
  for (const t of termRows) {
    out.get(t.circleId)?.terms.push({
      id: t.id,
      circleId: t.circleId,
      dimensionKey: t.dimensionKey,
      slug: t.slug,
      label: t.label,
      implies: normalizeWhen(t.implies),
      aliases: [...t.aliases],
      autoRegistered: t.autoRegistered,
    })
  }
  return out
}
