import type { LifecycleEvent, RecallRequest, RecallResponse, WhoAmI } from '@kioku/contracts'

import { conversationRefOf, touchConversation } from '../access/conversations'
import { defaultSession, resolveKeySession, type KeySession } from '../access/session'
import { loggableError, withSpace } from '../db/client'
import { bufferTurn, canWriteTurns } from '../extraction/buffer'
import type { Deps, KeyPrincipal } from '../http/env'
import { handleLifecycle, type LifecycleResult } from './lifecycle'
import type { RecallScope } from './scope'

// 接入方接口的处理，路由与测试台共用。scope 由调用方按解析出的会话给出，这里不新建：
// 测试台要用事务里的 deps 建，还要关掉召回事件
export type ScopeFor = (session: KeySession) => RecallScope

export async function lifecycleEvent(
  deps: Deps,
  key: KeyPrincipal,
  input: LifecycleEvent,
  scopeFor: ScopeFor,
): Promise<LifecycleResult> {
  if (input.event === 'turn.end') {
    // 写不进抽取结果的 Key 不缓冲，也不解析会话、不建联系人。不带会话上下文的轮次只用来写会话摘要，
    // 按应用与所属成员缓冲
    if (canWriteTurns(key.scopes, input.context !== undefined)) {
      const session = input.context
        ? await resolveKeySession(deps, key, input.context)
        : defaultSession(key)
      await touchConversationOf(deps, key, session)
      await bufferTurn(deps, key, session, input)
    }
    return { hostOutput: { mode: 'none', value: null }, nodeUris: [] }
  }
  const session = await resolveKeySession(deps, key, input.context)
  await touchConversationOf(deps, key, session)
  return handleLifecycle(scopeFor(session), key.app.runtimeFamily, input)
}

// 生命周期事件来时建立会话或更新最近活动（定时任务与子 Agent 不算会话）。会话只是对话页的索引，
// 写不进去时记日志、不影响召回与缓冲；回滚模式下 deps.db 是测试台的事务，在 withSpace 的 savepoint 里写
async function touchConversationOf(deps: Deps, key: KeyPrincipal, session: KeySession) {
  const ref = conversationRefOf(session.context, key.app.ownerAccountId)
  if (!ref) return
  try {
    await withSpace(deps.db, key.spaceId, (tx) =>
      touchConversation(tx, key.spaceId, key.app.id, ref),
    )
  } catch (err) {
    console.warn('记下会话的最近活动失败', loggableError(err))
  }
}

export async function recallRequest(
  deps: Deps,
  key: KeyPrincipal,
  { query, limit, context }: RecallRequest,
  scopeFor: ScopeFor,
): Promise<RecallResponse> {
  const scope = scopeFor(await resolveKeySession(deps, key, context))
  const [candidates, subjects] = await Promise.all([
    scope.recall(query, { limit }),
    scope.subjects(),
  ])
  scope.record('rest.recall', query, candidates)
  return { candidates, subjects }
}

export function whoamiOf(key: KeyPrincipal): WhoAmI {
  return { spaceId: key.spaceId, app: key.app, scopes: key.scopes }
}
