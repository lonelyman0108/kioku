import { accessForKey, defaultSession, type KeySession } from '../access/session'
import type { Deps, KeyPrincipal } from '../http/env'
import { consoleCircleFor } from '../memory/entryContext'
import { MemoryError } from '../memory/errors'
import { CredentialService, type CredentialContext } from './service'

// 凭据和个人记忆一样按记忆圈成员算，会话上下文的收紧照常生效：群聊、私聊、定时任务、子 agent 都用不了凭据。
// options 给测试台：不给值、不记访问，以及事件的标记
export function credentialServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
  options: Pick<CredentialContext, 'bench' | 'eventContext'> = {},
): CredentialService {
  return new CredentialService({
    db: deps.db,
    circleId: key.circleId,
    access: accessForKey(key, session),
    masterKey: deps.masterKey,
    vault: deps.vault,
    actor: { keyId: key.keyId },
    chatType: session.context.chatType ?? 'none',
    ...options,
  })
}

// 管理界面：先确认是记忆圈成员（不是就 403）。每个成员只看得到自己的凭据与连接，记忆圈所有者也看不到别人的
export async function credentialServiceForConsole(
  deps: Deps,
  circleId: string,
  accountId: string,
): Promise<CredentialService> {
  const resolved = await consoleCircleFor(deps, accountId, circleId)
  if (!resolved) throw new MemoryError(403, '无权访问此记忆圈')
  return new CredentialService({
    db: deps.db,
    circleId,
    access: resolved.access,
    masterKey: deps.masterKey,
    vault: deps.vault,
    actor: { accountId },
  })
}
