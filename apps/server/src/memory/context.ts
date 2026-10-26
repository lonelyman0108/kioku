import { resolveAccess, type SessionContext } from '../access/access'
import type { Deps, KeyPrincipal } from '../http/env'
import { MemoryService } from './service'

// 由 API Key 构造记忆服务；会话上下文在接入群聊（对象解析）之后才会传进来
export function memoryServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  context: SessionContext = {},
): MemoryService {
  const access = resolveAccess(
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
  return new MemoryService({
    db: deps.db,
    spaceId: key.spaceId,
    access,
    personaId: key.app.defaultPersonaId,
    masterKey: deps.masterKey,
    actor: { keyId: key.keyId },
    onChanged: (memoryId) => deps.jobs?.enqueueEmbed(key.spaceId, memoryId),
  })
}
