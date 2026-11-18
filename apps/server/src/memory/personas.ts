import type { ResolvedPersonaTrait } from '@kioku/contracts'
import { asc, eq, inArray } from 'drizzle-orm'

import { withCircle, type Db, type Tx } from '../db/client'
import { personaTraits, personas } from '../db/schema'

// 继承链（含自己）最多这么多层：新建与修改继承时检查，读的时候超出的部分不再往上找
export const MAX_PERSONA_DEPTH = 8

// 人格及其继承链，从自己到最远的祖先；遇到环或超过深度就停
export async function personaChain(tx: Tx, personaId: string | null): Promise<string[]> {
  const chain: string[] = []
  let current = personaId
  while (current && chain.length < MAX_PERSONA_DEPTH && !chain.includes(current)) {
    chain.push(current)
    const [row] = await tx
      .select({ extendsId: personas.extendsId })
      .from(personas)
      .where(eq(personas.id, current))
      .limit(1)
    current = row?.extendsId ?? null
  }
  return chain
}

export async function personaIdsBySlug(tx: Tx, slugs: string[]): Promise<Map<string, string>> {
  if (!slugs.length) return new Map()
  const rows = await tx
    .select({ id: personas.id, slug: personas.slug })
    .from(personas)
    .where(inArray(personas.slug, slugs))
  return new Map(rows.map((r) => [r.slug, r.id]))
}

// 沿继承链（自身优先于祖先）按 traitKey 覆盖合并 persona_traits
export async function resolvePersonaTraits(
  tx: Tx,
  personaId: string | null,
): Promise<ResolvedPersonaTrait[]> {
  const chain = await personaChain(tx, personaId)
  if (!chain.length) return []
  const rows = await tx
    .select()
    .from(personaTraits)
    .where(inArray(personaTraits.personaId, chain))
    .orderBy(asc(personaTraits.sortOrder), asc(personaTraits.traitKey))

  const rank = new Map(chain.map((id, i) => [id, i]))
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const existing = byKey.get(row.traitKey)
    if (!existing || (rank.get(row.personaId) ?? 999) < (rank.get(existing.personaId) ?? 999)) {
      byKey.set(row.traitKey, row)
    }
  }
  return [...byKey.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.traitKey.localeCompare(b.traitKey))
    .map((r) => ({
      traitKey: r.traitKey,
      title: r.title,
      content: r.content,
      sortOrder: r.sortOrder,
      updatedAt: r.updatedAt.toISOString(),
      personaId: r.personaId,
      overriddenBy: null,
    }))
}

export function runInCircle<T>(
  db: Db,
  circleId: string,
  fn: (tx: Tx, now: Date) => Promise<T>,
): Promise<T> {
  return withCircle(db, circleId, fn)
}
