import { resolveAccess, type Access, type SessionContext } from '../access/access'
import { withSpace } from '../db/client'
import type { Deps, KeyPrincipal } from '../http/env'
import type { RecallScope } from '../lifecycle/scope'
import { personaChain } from './personas'
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

export function recallScopeForKey(
  deps: Deps,
  key: KeyPrincipal,
  context: SessionContext = {},
): RecallScope {
  return {
    access: accessForKey(key, context),
    run: (fn) =>
      withSpace(deps.db, key.spaceId, async (tx) =>
        fn(tx, await personaChain(tx, key.app.defaultPersonaId)),
      ),
    embedder: () => deps.embedder.get().catch(() => null),
  }
}
