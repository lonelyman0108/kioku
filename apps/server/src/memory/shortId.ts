import { randomInt } from 'node:crypto'

import {
  isShortId,
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  SHORT_ID_PREFIX,
  WIKI_LINK_REGEX,
  type RemappedShortId,
} from '@kioku/contracts'
import { inArray } from 'drizzle-orm'

import { isUniqueViolation, withCircles, type Tx } from '../db/client'
import { circles, entries } from '../db/schema'

const CANDIDATE_BATCH = 32
const MAX_ALLOCATE_ATTEMPTS = 16

export function generateShortId(length = SHORT_ID_LENGTH): string {
  let body = ''
  for (let i = 0; i < length; i++) {
    body += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)]
  }
  return `${SHORT_ID_PREFIX}${body}`
}

export function normalizeShortId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return isShortId(normalized) ? normalized : null
}

// 在内部 SAVEPOINT 中分配并发安全的全局唯一短 ID；发生碰撞（entries_short_id_unique）时仅回滚当次尝试并重试，
// 不破坏外层事务，6 位连续碰撞后平滑升至 7～8 位
export async function insertWithAllocatedShortId<T>(
  tx: Tx,
  attempt: (sp: Tx, shortId: string) => Promise<T>,
): Promise<{ shortId: string; value: T }> {
  for (let i = 0; i < MAX_ALLOCATE_ATTEMPTS; i++) {
    const length = i < 8 ? SHORT_ID_LENGTH : i < 12 ? 7 : 8
    const shortId = generateShortId(length)
    try {
      const value = await tx.transaction((sp) => attempt(sp, shortId))
      return { shortId, value }
    } catch (err) {
      if (isUniqueViolation(err, 'entries_short_id_unique') && i < MAX_ALLOCATE_ATTEMPTS - 1) {
        continue
      }
      throw err
    }
  }
  throw new Error('短 ID 分配重试次数已耗尽')
}

async function existingShortIds(
  tx: Tx,
  allCircleIds: readonly string[],
  candidates: readonly string[],
): Promise<Set<string>> {
  if (!candidates.length || !allCircleIds.length) return new Set()
  const unique = [...new Set(candidates.map((s) => s.toLowerCase()))]
  const used = new Set<string>()
  await withCircles(
    tx,
    { read: allCircleIds },
    async (readTx) => {
      for (let i = 0; i < unique.length; i += 500) {
        const chunk = unique.slice(i, i + 500)
        const rows = await readTx
          .select({ shortId: entries.shortId })
          .from(entries)
          .where(inArray(entries.shortId, chunk))
        for (const r of rows) used.add(r.shortId)
      }
    },
    { accessMode: 'read only' },
  )
  return used
}

// 导入前批量为一组目标短 ID 分配全实例（含已软删除行）无冲突的新短 ID；未碰撞且包内不重复的原样保留
export async function allocateUniqueShortIds(
  tx: Tx,
  desired: readonly string[],
): Promise<{ assigned: Map<string, string>; remapped: RemappedShortId[] }> {
  const normalized = desired.map((d) => d.trim().toLowerCase())
  const allCircleIds = (await tx.select({ id: circles.id }).from(circles)).map((c) => c.id)
  const taken = await existingShortIds(tx, allCircleIds, normalized)
  const reserved = new Set<string>(taken)

  const assigned = new Map<string, string>()
  const remapped: RemappedShortId[] = []
  const needFresh: string[] = []

  for (const oldId of normalized) {
    if (assigned.has(oldId)) continue
    if (!reserved.has(oldId)) {
      reserved.add(oldId)
      assigned.set(oldId, oldId)
    } else {
      needFresh.push(oldId)
    }
  }

  let idx = 0
  let round = 0
  while (idx < needFresh.length) {
    const length = round < 4 ? SHORT_ID_LENGTH : 7
    const pool: string[] = []
    const needed = needFresh.length - idx
    const batchCount = Math.max(needed * 2, CANDIDATE_BATCH)
    for (let j = 0; j < batchCount; j++) {
      const candidate = generateShortId(length)
      if (!reserved.has(candidate)) pool.push(candidate)
    }
    const collided = await existingShortIds(tx, allCircleIds, pool)
    for (const c of collided) reserved.add(c)
    for (const candidate of pool) {
      if (idx >= needFresh.length) break
      if (reserved.has(candidate)) continue
      const from = needFresh[idx++]!
      reserved.add(candidate)
      assigned.set(from, candidate)
      remapped.push({ from, to: candidate })
    }
    round++
    if (round > 32) throw new Error('批量分配短 ID 重试次数已耗尽')
  }

  return { assigned, remapped }
}

// 按映射表流式重写文本中的所有 [[m-xxxxxx]] 与 [[m-xxxxxx|别名]] 双链目标，未在映射表中的目标原样保留
export function rewriteWikiLinks(text: string, remap: ReadonlyMap<string, string>): string {
  if (!remap.size || !text.includes('[[')) return text
  const regex = new RegExp(WIKI_LINK_REGEX.source, 'gi')
  return text.replace(regex, (raw, id: string, alias?: string) => {
    const next = remap.get(id.toLowerCase())
    if (!next || next === id.toLowerCase()) return raw
    return alias !== undefined ? `[[${next}|${alias}]]` : `[[${next}]]`
  })
}
