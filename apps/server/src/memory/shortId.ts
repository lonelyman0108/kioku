import { randomInt } from 'node:crypto'

import { isShortId, SHORT_ID_ALPHABET, SHORT_ID_LENGTH, SHORT_ID_PREFIX } from '@kioku/contracts'

import { isUniqueViolation, type Tx } from '../db/client'

const MAX_ALLOCATE_ATTEMPTS = 16

export function generateShortId(length = SHORT_ID_LENGTH): string {
  let body = ''
  for (let i = 0; i < length; i++) {
    body += SHORT_ID_ALPHABET[randomInt(SHORT_ID_ALPHABET.length)]
  }
  return `${SHORT_ID_PREFIX}${body}`
}

export function parseShortId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return isShortId(normalized) ? normalized : null
}

// 在内部 SAVEPOINT 中分配并发安全的全局唯一短 ID；碰撞时仅回滚当次尝试并自动升位重试
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
      if (isUniqueViolation(err, 'entries_shortId_unique') && i < MAX_ALLOCATE_ATTEMPTS - 1) {
        continue
      }
      if (isUniqueViolation(err, 'entries_short_id_unique') && i < MAX_ALLOCATE_ATTEMPTS - 1) {
        continue
      }
      throw err
    }
  }
  throw new Error('短 ID 分配重试次数已耗尽')
}
