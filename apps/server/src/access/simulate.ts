import { KeyScopes } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'

import { keyPrincipal, memberRole } from '../auth/middleware'
import { withSpace } from '../db/client'
import { apiKeys, apps, spaceMembers } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { keyEffectiveScopes } from './access'

export type SimulatedKey = { key: KeyPrincipal } | { error: string; status: 403 | 404 }

// 模拟用的 Key（启动预览、召回调试、测试台）：只有应用主人能用，因为模拟会读到主人的私人层与提示语（空间 owner 也不行）。
// 权限按这把 Key 现在的有效上限，作废的 Key 不能模拟
export async function keyToSimulate(
  deps: Deps,
  { spaceId, appId, keyId }: { spaceId: string; appId: string; keyId: string },
  accountId: string,
): Promise<SimulatedKey> {
  if (!(await memberRole(deps, spaceId, accountId))) {
    return { error: '不是该空间成员', status: 403 }
  }
  const found = await withSpace(deps.db, spaceId, async (tx) => {
    const [app] = await tx.select().from(apps).where(eq(apps.id, appId))
    if (!app) return 'no-app' as const
    if (app.ownerAccountId !== accountId) return 'forbidden' as const
    const [key] = await tx
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.appId, appId)))
    return key ? { app, key } : ('no-key' as const)
  })
  if (found === 'no-app') return { error: '应用不存在', status: 404 }
  if (found === 'forbidden') return { error: '只有应用的主人能模拟它的 Key', status: 403 }
  if (found === 'no-key') return { error: 'Key 不存在', status: 404 }
  const { app, key } = found
  const [owner] = await deps.db
    .select({ role: spaceMembers.role, memberSince: spaceMembers.createdAt })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.accountId, accountId)))
  const scopes = keyEffectiveScopes({ ...key, scopes: KeyScopes.parse(key.scopes) }, owner)
  if (!scopes) return { error: 'Key 已作废', status: 404 }
  return { key: keyPrincipal(key, app, scopes) }
}
