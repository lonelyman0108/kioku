import type { OriginScope } from '@kioku/contracts'
import { inArray } from 'drizzle-orm'

import type { Tx } from '../db/client'
import { UUID } from '../db/paging'
import { apps, subjects } from '../db/schema'

// 来源作用域（global、app:<id>、group:<对象>、direct:<对象>）换成带名字的形式；应用或对象删掉了时名字为空
export async function scopeNames(
  tx: Tx,
  scopes: string[],
): Promise<(scope: string) => OriginScope> {
  const parse = (scope: string) => {
    const [kind, id] = scope.split(':', 2) as [string, string | undefined]
    return { kind, id: id && UUID.test(id) ? id : null }
  }
  const parsed = scopes.map(parse)
  const appIds = [...new Set(parsed.filter((p) => p.kind === 'app' && p.id).map((p) => p.id!))]
  const subjectIds = [
    ...new Set(
      parsed.filter((p) => (p.kind === 'group' || p.kind === 'direct') && p.id).map((p) => p.id!),
    ),
  ]
  const [appRows, subjectRows] = await Promise.all([
    appIds.length
      ? tx.select({ id: apps.id, name: apps.name }).from(apps).where(inArray(apps.id, appIds))
      : [],
    subjectIds.length
      ? tx
          .select({ id: subjects.id, name: subjects.displayName })
          .from(subjects)
          .where(inArray(subjects.id, subjectIds))
      : [],
  ])
  const names = new Map([...appRows, ...subjectRows].map((r) => [r.id, r.name]))
  return (scope) => {
    const { kind, id } = parse(scope)
    if (kind === 'app' || kind === 'group' || kind === 'direct') {
      return { kind, id, name: id ? (names.get(id) ?? null) : null }
    }
    return { kind: 'global', id: null, name: null }
  }
}
