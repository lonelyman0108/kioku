import { eq } from 'drizzle-orm'

import {
  consoleAccess,
  resolveAccess,
  type Access,
  type ConsoleRole,
  type SessionContext,
} from '../access/access'
import { withSpace, type Tx } from '../db/client'
import { apps } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import type { RecallScope } from '../lifecycle/scope'
import { boot, recentMemories } from '../recall/boot'
import { embedQuery, normalizeQuery, recall } from '../recall/recall'
import { runInSpace } from './personas'
import { MemoryService } from './service'

// 会话上下文在接入群聊（对象解析）之后才会传进来，目前都按无上下文处理
function accessForKey(key: KeyPrincipal, context: SessionContext): Access {
  return resolveAccess(
    key.scopes,
    {
      appId: key.app.id,
      ownerAccountId: key.app.ownerAccountId,
      ...(key.app.config.elevateOwnerDirect
        ? { elevateOwnerDirect: key.app.config.elevateOwnerDirect }
        : {}),
    },
    context,
  )
}

export function memoryServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  context: SessionContext = {},
): MemoryService {
  return new MemoryService({
    db: deps.db,
    spaceId: key.spaceId,
    access: accessForKey(key, context),
    personaId: key.app.defaultPersonaId,
    masterKey: deps.masterKey,
    actor: { keyId: key.keyId },
    onChanged: (memoryId) => deps.jobs?.enqueueEmbed(key.spaceId, memoryId),
  })
}

// 管理界面：按成员角色给权限，能看到空间里全部人格与应用的记忆，私人层只看得到自己的；
// editor 只能写自己是主人的应用的应用层
export async function memoryServiceForConsole(
  deps: Deps,
  spaceId: string,
  accountId: string,
  role: ConsoleRole,
): Promise<MemoryService> {
  const owned =
    role === 'editor'
      ? await withSpace(deps.db, spaceId, (tx) =>
          tx.select({ id: apps.id }).from(apps).where(eq(apps.ownerAccountId, accountId)),
        )
      : []
  return new MemoryService({
    db: deps.db,
    spaceId,
    access: consoleAccess(
      role,
      accountId,
      owned.map((a) => a.id),
    ),
    personaId: 'all',
    masterKey: deps.masterKey,
    actor: { accountId },
    onChanged: (memoryId) => deps.jobs?.enqueueEmbed(spaceId, memoryId),
  })
}

export function recallScopeForKey(
  deps: Deps,
  key: KeyPrincipal,
  context: SessionContext = {},
): RecallScope {
  const access = accessForKey(key, context)
  const run = <T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>) =>
    runInSpace(deps.db, key.spaceId, key.app.defaultPersonaId, fn)
  return {
    async recall(rawQuery, { semantic: useSemantic = true, semanticTimeoutMs, ...options }) {
      const query = normalizeQuery(rawQuery)
      if (!query) return []
      // 嵌入设置读不出来（例如主密钥不对）时记录原因，召回退化为全文与关键词
      const embedder = useSemantic
        ? await deps.embedder.get().catch((err: unknown) => {
            console.warn('读取嵌入设置失败，本次召回不使用向量', err)
            return null
          })
        : null
      // 嵌入接口慢时不拖住整个召回：到时间就放弃向量这一路
      const semantic = await (semanticTimeoutMs === undefined
        ? embedQuery(embedder, query)
        : Promise.race([
            embedQuery(embedder, query),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), semanticTimeoutMs)),
          ]))
      return run((tx, personaIds) =>
        recall(tx, access, semantic, query, { ...options, personaIds }),
      )
    },
    boot: (budget) => run((tx, personaIds) => boot(tx, access, personaIds, budget)),
    recent: (limit) => run((tx, personaIds) => recentMemories(tx, access, personaIds, limit)),
  }
}
