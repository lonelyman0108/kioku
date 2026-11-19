import { and, eq } from 'drizzle-orm'

import { memberRole, principalOf } from '../auth/middleware'
import { withCircle } from '../db/client'
import { apiKeys, clients } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'

export type SimulatedKey = { key: KeyPrincipal } | { error: string; status: 403 | 404 }

// 模拟用的密钥（启动预览、召回调试、测试台）：仅接入实例所有者本人可用，防止他人窥探个人圈或私密设置
export async function keyToSimulate(
  deps: Deps,
  { circleId, clientId, keyId }: { circleId: string; clientId: string; keyId: string },
  accountId: string,
): Promise<SimulatedKey> {
  if (!(await memberRole(deps, circleId, accountId))) {
    return { error: '无权访问此记忆圈', status: 403 }
  }
  const found = await withCircle(deps.db, circleId, async (tx) => {
    const [client] = await tx.select().from(clients).where(eq(clients.id, clientId))
    if (!client) return 'no-client' as const
    if (client.ownerAccountId !== accountId) return 'forbidden' as const
    const [key] = await tx
      .select()
      .from(apiKeys)
      .where(
        and(eq(apiKeys.id, keyId), eq(apiKeys.clientId, clientId), eq(apiKeys.circleId, circleId)),
      )
    return key ?? ('no-key' as const)
  })
  if (found === 'no-client') return { error: '接入实例不存在', status: 404 }
  if (found === 'forbidden')
    return { error: '仅接入实例所有者可模拟此接入实例的访问密钥', status: 403 }
  if (found === 'no-key') return { error: '访问密钥不存在', status: 404 }

  const principal = await principalOf(deps.db, found)
  if (!principal) return { error: '访问密钥已作废', status: 404 }
  return { key: principal }
}
