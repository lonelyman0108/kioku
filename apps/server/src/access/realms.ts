import { MAX_FACET_IMPLIES_DEPTH, type WhenCondition } from '@kioku/contracts'

export interface FacetTermImplies {
  dimensionKey: string
  slug: string
  implies: Record<string, readonly string[]>
}

function addTerm(target: Map<string, Set<string>>, dimensionKey: string, slug: string): boolean {
  const dim = dimensionKey.trim().toLowerCase()
  const val = slug.trim().toLowerCase()
  if (!dim || !val) return false
  let set = target.get(dim)
  if (!set) {
    set = new Set<string>()
    target.set(dim, set)
  }
  const sizeBefore = set.size
  set.add(val)
  return set.size > sizeBefore
}

// 按最大深度 MAX_FACET_IMPLIES_DEPTH 对切面条件做蕴含广度展开，遇到环时自动停止
export function expandWhenImplies(
  when: WhenCondition,
  terms: readonly FacetTermImplies[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  const termMap = new Map<string, FacetTermImplies>()
  for (const term of terms) {
    const dim = term.dimensionKey.trim().toLowerCase()
    const slug = term.slug.trim().toLowerCase()
    if (dim && slug) termMap.set(`${dim}\0${slug}`, term)
  }

  let frontier: [string, string][] = []
  for (const [rawDim, rawSlugs] of Object.entries(when)) {
    const dim = rawDim.trim().toLowerCase()
    if (!dim) continue
    for (const rawSlug of rawSlugs) {
      const slug = rawSlug.trim().toLowerCase()
      if (slug && addTerm(result, dim, slug)) {
        frontier.push([dim, slug])
      }
    }
  }

  for (let depth = 0; depth < MAX_FACET_IMPLIES_DEPTH && frontier.length > 0; depth++) {
    const next: [string, string][] = []
    for (const [dim, slug] of frontier) {
      const term = termMap.get(`${dim}\0${slug}`)
      if (!term) continue
      for (const [rawImpDim, rawImpSlugs] of Object.entries(term.implies)) {
        const impDim = rawImpDim.trim().toLowerCase()
        if (!impDim) continue
        for (const rawImpSlug of rawImpSlugs) {
          const impSlug = rawImpSlug.trim().toLowerCase()
          if (impSlug && addTerm(result, impDim, impSlug)) {
            next.push([impDim, impSlug])
          }
        }
      }
    }
    frontier = next
  }

  return result
}

// 从访问密钥静态 context_facets 与主场圈词表展开静态在场场域集合
export function resolveStaticContextRealms(
  contextFacets: WhenCondition,
  primaryCircleTerms: readonly FacetTermImplies[],
): Set<string> {
  if (!Object.keys(contextFacets).length) return new Set()
  return expandWhenImplies(contextFacets, primaryCircleTerms).get('realm') ?? new Set()
}

export function normalizeRealms(realms: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of realms) {
    const clean = raw.trim().toLowerCase()
    if (clean) out.add(clean)
  }
  return [...out]
}

export function effectiveTargetRealms(
  targetRealms: readonly string[],
  primaryCircleRealms: readonly string[],
): string[] {
  const explicit = normalizeRealms(targetRealms)
  return explicit.length > 0 ? explicit : normalizeRealms(primaryCircleRealms)
}

// 静态双向安全场域锁（只认密钥静态 allowedRealms 与静态 context_facets 展开的场域集）：
// 1. 目标有效场域优先取显式标注 realms，未标注时回退继承主场圈默认场域；
// 2. 若密钥设了非空 allowedRealms，则目标有效场域须非空且与之有交集；
// 3. 若目标有效场域非空且密钥静态 context_facets 展开了非空 realm，则两者须有交集
export function checkStaticRealmLock(
  targetRealms: readonly string[],
  primaryCircleRealms: readonly string[],
  allowedRealms: ReadonlySet<string> | null,
  staticContextRealms: ReadonlySet<string>,
): boolean {
  const eff = effectiveTargetRealms(targetRealms, primaryCircleRealms)
  if (allowedRealms !== null) {
    if (eff.length === 0 || !eff.some((r) => allowedRealms.has(r))) return false
  }
  if (eff.length > 0 && staticContextRealms.size > 0) {
    if (!eff.some((r) => staticContextRealms.has(r))) return false
  }
  return true
}
