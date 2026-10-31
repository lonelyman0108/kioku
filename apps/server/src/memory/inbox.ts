import type { InboxCounts } from '@kioku/contracts'
import { count } from 'drizzle-orm'

import { pendingBindingCount, type BindingViewer } from '../access/binding'
import { withSpace, type Db } from '../db/client'
import { memories } from '../db/schema'
import { pendingReview } from './filter'
import type { MemoryService } from './service'
import { openSuggestionCount } from './suggestions'

// 待处理总数：导航每个页面都读，只数不取内容。每一类和对应的列表同一个条件（账号绑定 pendingBindingsFor、
// 待确认内容 pendingReview、Dream 的建议 listSuggestions、疑似明文 plaintext 筛选），调用方看不到的不算。
// 概览已经算过疑似明文的条数，从 plaintext 传进来，不再算一遍
export async function inboxCounts(
  db: Db,
  spaceId: string,
  service: MemoryService,
  viewer: BindingViewer,
  plaintext?: number,
): Promise<InboxCounts> {
  const [others, suspects] = await Promise.all([
    withSpace(db, spaceId, async (tx) => {
      const bindings = await pendingBindingCount(tx, viewer)
      // 对象层与情节层不分人格，读权限里的人格限制用不上
      const [review] = await tx
        .select({ n: count() })
        .from(memories)
        .where(pendingReview(service.access, []))
      const dreamSuggestions = await openSuggestionCount(tx, service.access)
      return { bindings, review: review?.n ?? 0, dreamSuggestions }
    }),
    plaintext ?? service.plaintextCount(),
  ])
  return {
    ...others,
    plaintext: suspects,
    total: others.bindings + others.review + others.dreamSuggestions + suspects,
  }
}
