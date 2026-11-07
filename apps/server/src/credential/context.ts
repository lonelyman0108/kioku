import { consoleAccess } from '../access/access'
import { defaultSession, type KeySession } from '../access/session'
import type { Deps, KeyPrincipal } from '../http/env'
import { accessForKey, consoleRoleFor } from '../memory/context'
import { CredentialService, type CredentialContext } from './service'

// 凭据和本人的记忆一样按应用所有者算，会话上下文的收紧照常生效：群聊、私聊、定时任务、子 agent 都用不了凭据。
// options 给测试台：不给值、不记访问，以及事件的标记
export function credentialServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
  options: Pick<CredentialContext, 'bench' | 'eventContext'> = {},
): CredentialService {
  return new CredentialService({
    db: deps.db,
    spaceId: key.spaceId,
    access: accessForKey(key, session),
    masterKey: deps.masterKey,
    vault: deps.vault,
    actor: { keyId: key.keyId },
    chatType: session.context.chatType ?? 'none',
    ...options,
  })
}

// 管理界面：先确认是空间成员（不是就 403）。每个成员只看得到自己的凭据与连接，空间 owner 也看不到别人的
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
    vault: deps.vault,
    actor: { accountId },
  })
}
