import { SENSITIVITIES, type Sensitivity } from '@kioku/contracts'
import { and, eq, gt, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'

import type { Access, ReadOptions } from '../access/access'
import { sensitivityRank } from '../access/access'
import { memories } from '../db/schema'

// canRead 的 SQL 版本，用在召回、搜索和列表查询里。两边规则必须一致，
// filter.int.test.ts 用同一批数据逐条比对二者的结果。
export function readableConditions(access: Access, options: ReadOptions): SQL {
  const now = options.now ?? new Date()
  const conditions: (SQL | undefined)[] = [
    isNull(memories.deletedAt),
    or(isNull(memories.validTo), gt(memories.validTo, now)),
    or(isNull(memories.expiresAt), gt(memories.expiresAt, now)),
  ]

  const layers = [...access.readLayers]
  conditions.push(layers.length ? inArray(memories.layer, layers) : sql`false`)

  const allowed: Sensitivity[] = SENSITIVITIES.filter(
    (s) => s !== 'secret' && sensitivityRank(s) <= sensitivityRank(access.maxSensitivity),
  )
  if (options.explicit && access.canReadSecret) allowed.push('secret')
  conditions.push(allowed.length ? inArray(memories.sensitivity, allowed) : sql`false`)

  if (access.originScopes) conditions.push(inArray(memories.originScope, [...access.originScopes]))

  conditions.push(
    or(
      notInArray(memories.layer, ['owner', 'private']),
      eq(memories.ownerAccountId, access.ownerAccountId),
    ),
    options.personaIds.length
      ? or(ne(memories.layer, 'persona'), inArray(memories.personaId, [...options.personaIds]))
      : ne(memories.layer, 'persona'),
    or(ne(memories.layer, 'app'), eq(memories.appId, access.appId)),
  )
  return and(...conditions)!
}
