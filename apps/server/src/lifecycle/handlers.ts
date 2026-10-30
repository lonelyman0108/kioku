import type { LifecycleEvent, RecallRequest, RecallResponse, WhoAmI } from '@kioku/contracts'

import { resolveKeySession, type KeySession } from '../access/session'
import { bufferTurn, canBufferTurns } from '../extraction/buffer'
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
    if (canBufferTurns(key)) {
      await bufferTurn(deps, key, await resolveKeySession(deps, key, input.context), input)
    }
    return { hostOutput: { mode: 'none', value: null }, nodeUris: [] }
  }
  const session = await resolveKeySession(deps, key, input.context)
  return handleLifecycle(scopeFor(session), key.app.runtimeFamily, input)
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
