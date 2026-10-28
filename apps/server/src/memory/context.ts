import type { MemberRole, RecallCandidate } from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import { consoleAccess, resolveAccess, type Access, type ConsoleRole } from '../access/access'
import { defaultSession, type KeySession } from '../access/session'
import { memberRole } from '../auth/middleware'
import { withSpace, type Tx } from '../db/client'
import { apps } from '../db/schema'
import type { Embedder } from '../embedding/provider'
import type { Deps, KeyPrincipal } from '../http/env'
import type { RecallScope } from '../lifecycle/scope'
import { boot, recentMemories } from '../recall/boot'
import { recordRecall } from '../recall/events'
import { subjectFacts } from '../recall/subjects'
import {
  embedQuery,
  normalizeQuery,
  publicCandidate,
  recall,
  scoreRecall,
  type QueryVector,
} from '../recall/recall'
import { runInSpace } from './personas'
import { MemoryError, MemoryService } from './service'

// 管理界面的搜索等嵌入接口最多这么久，超时就只走全文与关键词，界面不必一直等
const CONSOLE_SEMANTIC_TIMEOUT_MS = 2_000

// 会话由 resolveKeySession 从接入方上报的会话上下文解析出来；不带上下文时按应用的默认人格、不收紧
export function accessForKey(key: KeyPrincipal, session: KeySession = defaultSession(key)): Access {
  return resolveAccess(
    key.scopes,
    {
      appId: key.app.id,
      ownerAccountId: key.app.ownerAccountId,
      personaId: session.personaId,
      ...(key.app.config.elevateOwnerDirect
        ? { elevateOwnerDirect: key.app.config.elevateOwnerDirect }
        : {}),
    },
    session.context,
  )
}

// 管理界面里成员本人的权限；editor 只能写自己是主人的应用的应用层，要先查出这些应用
async function accessForConsole(
  deps: Deps,
  spaceId: string,
  accountId: string,
  role: ConsoleRole,
): Promise<Access> {
  const owned =
    role === 'editor'
      ? await withSpace(deps.db, spaceId, (tx) =>
          tx.select({ id: apps.id }).from(apps).where(eq(apps.ownerAccountId, accountId)),
        )
      : []
  return consoleAccess(
    role,
    accountId,
    owned.map((a) => a.id),
  )
}

// 查询向量：嵌入设置读不出来（例如主密钥不对）时记录原因、不用向量。
// 给了时限就最多等这么久，读嵌入设置的时间也算在内
export async function semanticFor(
  deps: Deps,
  query: string,
  timeoutMs?: number,
): Promise<QueryVector | null> {
  const compute = async () => {
    const embedder: Embedder | null = await deps.embedder.get().catch((err: unknown) => {
      console.warn('读取嵌入设置失败，本次召回不使用向量', err)
      return null
    })
    return embedQuery(embedder, query)
  }
  if (timeoutMs === undefined) return compute()
  // 先返回的一方胜出后清掉计时器，不留着它等到点
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      compute(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// 管理界面的请求：先确认是空间成员（不是就 403），再按他的角色建记忆服务。各个管理界面接口都经过这里
export async function consoleMemberFor(
  deps: Deps,
  spaceId: string,
  accountId: string,
): Promise<{ role: MemberRole; service: MemoryService }> {
  const role = await memberRole(deps, spaceId, accountId)
  if (!role) throw new MemoryError(403, '不是该空间成员')
  return { role, service: await memoryServiceForConsole(deps, spaceId, accountId, role) }
}

export function memoryServiceForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
): MemoryService {
  return new MemoryService({
    db: deps.db,
    spaceId: key.spaceId,
    access: accessForKey(key, session),
    personaId: session.personaId,
    masterKey: deps.masterKey,
    actor: { keyId: key.keyId },
    onChanged: (memoryId) => deps.jobs?.enqueueEmbed(key.spaceId, memoryId),
  })
}

// 管理界面：按成员角色给权限，能看到空间里全部人格与应用的记忆，私人层只看得到自己的；
// editor 只能写自己是主人的应用的应用层。能显式读 secret 的成员在树与列表里也看得到 secret 记忆
export async function memoryServiceForConsole(
  deps: Deps,
  spaceId: string,
  accountId: string,
  role: ConsoleRole,
): Promise<MemoryService> {
  const access = await accessForConsole(deps, spaceId, accountId, role)
  return new MemoryService({
    db: deps.db,
    spaceId,
    access,
    personaId: 'all',
    masterKey: deps.masterKey,
    actor: { accountId },
    onChanged: (memoryId) => deps.jobs?.enqueueEmbed(spaceId, memoryId),
    listSecret: access.canReadSecret,
  })
}

// 管理界面的搜索候选：和接入方的召回同一套打分，按成员本人的权限，看得到所有人格与应用的记忆。
// 召回永远不含 secret；最低分放到 0，弱一些的命中也列出来，由人来判断
// access 取自同一个请求里的管理界面记忆服务，权限只算一次
export async function recallForConsole(
  deps: Deps,
  spaceId: string,
  access: Access,
  rawQuery: string,
  limit: number,
): Promise<RecallCandidate[]> {
  const query = normalizeQuery(rawQuery)
  if (!query) return []
  const semantic = await semanticFor(deps, query, CONSOLE_SEMANTIC_TIMEOUT_MS)
  return runInSpace(deps.db, spaceId, 'all', (tx, personaIds) =>
    recall(tx, access, semantic, query, { limit, minScore: 0, personaIds }),
  )
}

export function recallScopeForKey(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
): RecallScope {
  const access = accessForKey(key, session)
  const run = <T>(fn: (tx: Tx, personaIds: string[]) => Promise<T>) =>
    runInSpace(deps.db, key.spaceId, session.personaId, fn)
  return {
    async recall(rawQuery, { semantic: useSemantic = true, semanticTimeoutMs, ...options }) {
      const query = normalizeQuery(rawQuery)
      if (!query) return []
      // 嵌入接口慢时不拖住整个召回：到时间就放弃向量这一路
      const semantic = useSemantic ? await semanticFor(deps, query, semanticTimeoutMs) : null
      const scored = await run((tx, personaIds) =>
        scoreRecall(tx, access, semantic, query, { ...options, personaIds, inheritance: true }),
      )
      return scored.map(publicCandidate)
    },
    boot: (budget) =>
      run((tx, personaIds) => boot(tx, access, { personaIds, inheritance: true }, budget)),
    recent: (limit) =>
      run((tx, personaIds) => recentMemories(tx, access, { personaIds, inheritance: true }, limit)),
    // 对象层不用人格链，不经过 run
    subjects: async () =>
      session.subjects.length
        ? withSpace(deps.db, key.spaceId, (tx) => subjectFacts(tx, access, session.subjects))
        : [],
    record: (source, query, hits) => void recordRecall(deps, key, source, query, hits),
  }
}
