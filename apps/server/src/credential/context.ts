import { consoleAccess } from '../access/access'
import { defaultSession, type KeySession } from '../access/session'
import type { Deps, KeyPrincipal } from '../http/env'
import { accessForKey, consoleRoleFor } from '../memory/context'
import { CredentialService } from './service'

// 凭据和私人层一样按应用主人算，会话上下文的收紧照常生效：群聊、私聊、定时任务读不到私人层，也就看不到凭据
export function credentialServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
): CredentialService {
  return new CredentialService({
    db: deps.db,
    spaceId: key.spaceId,
    access: accessForKey(key, session),
    masterKey: deps.masterKey,
    actor: { keyId: key.keyId },
  })
}

// 管理界面：先确认是空间成员（不是就 403）。每个成员只看得到自己的凭据，空间 owner 也看不到别人的
export async function credentialServiceForConsole(
  deps: Deps,
  spaceId: string,
  accountId: string,
): Promise<CredentialService> {
  const role = await consoleRoleFor(deps, spaceId, accountId)
  return new CredentialService({
    db: deps.db,
    spaceId,
    access: consoleAccess(role, accountId),
    masterKey: deps.masterKey,
    actor: { accountId },
  })
}
