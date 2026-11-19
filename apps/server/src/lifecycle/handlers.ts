import {
  BUILTIN_FACET_DIMENSIONS,
  BUILTIN_FACET_KEYS,
  DISPLAY_NAME_MAX,
  isBuiltinFacetKey,
  normalizeWhen,
  sensitivityRank,
  type LifecycleEvent,
  type LifecycleProject,
  type RecallRequest,
  type RecallResponse,
  type SessionContextInput,
  type WhenCondition,
  type WhoAmI,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import { conversationRefOf, touchConversation } from '../access/conversations'
import { accessForKey, defaultSession, resolveKeySession, type KeySession } from '../access/session'
import { loggableError, withCircles } from '../db/client'
import { personas } from '../db/schema'
import { bufferTurn, canWriteTurns } from '../extraction/buffer'
import type { Deps, KeyPrincipal } from '../http/env'
import { resolveScopeFocusIn } from '../memory/context'
import { loadCircleVocabularies, normalizeProjectSlug } from '../memory/facets'
import { isRestrictedChatAccess } from '../memory/links'
import { clipChars, oneLine } from '../recall/text'
import { handleLifecycle, type LifecycleResult } from './lifecycle'
import type { RecallScope } from './scope'

export interface ScopeRequestOptions {
  deviceKey?: string | undefined
  project?: LifecycleProject | undefined
  facets?: WhenCondition | undefined
  crossCircle?: boolean | undefined
}

export type ScopeFor = (session: KeySession, options?: ScopeRequestOptions) => RecallScope

export async function lifecycleEvent(
  deps: Deps,
  key: KeyPrincipal,
  input: LifecycleEvent,
  scopeFor: ScopeFor,
): Promise<LifecycleResult> {
  const projectSlug = normalizeProjectSlug(input.project) ?? ''
  if (input.event === 'turn.end') {
    const primaryGrant = key.circleGrants.find((g) => g.circleId === key.circleId && g.active)
    if (primaryGrant && canWriteTurns(primaryGrant, input.context !== undefined)) {
      const session = input.context
        ? await resolveKeySession(deps, key, input.context)
        : defaultSession(key)
      await touchConversationOf(deps, key, session, {
        deviceKey: input.deviceKey,
        projectSlug,
      })
      await bufferTurn(deps, key, session, input)
    }
    return { hostOutput: { mode: 'none', value: null }, shortIds: [] }
  }
  const session = await resolveKeySession(deps, key, input.context)
  await touchConversationOf(deps, key, session, {
    deviceKey: input.deviceKey,
    projectSlug,
  })
  const scope = scopeFor(session, {
    ...(input.deviceKey !== undefined ? { deviceKey: input.deviceKey } : {}),
    ...(input.project !== undefined ? { project: input.project } : {}),
  })
  return handleLifecycle(scope, key.client.runtimeFamily, input)
}

async function touchConversationOf(
  deps: Deps,
  key: KeyPrincipal,
  session: KeySession,
  options: { deviceKey?: string | null | undefined; projectSlug?: string | null | undefined } = {},
) {
  const ref = conversationRefOf(session.context, key.client.ownerAccountId, {
    ...(options.deviceKey !== undefined ? { deviceKey: options.deviceKey } : {}),
    ...(options.projectSlug !== undefined ? { projectSlug: options.projectSlug } : {}),
  })
  if (!ref) return
  try {
    await withCircles(deps.db, { read: [key.circleId], write: [key.circleId] }, (tx) =>
      touchConversation(tx, key.circleId, key.client.id, ref),
    )
  } catch (err) {
    console.warn('记下会话的最近活动失败', loggableError(err))
  }
}

export async function recallRequest(
  deps: Deps,
  key: KeyPrincipal,
  req: RecallRequest,
  scopeFor: ScopeFor,
): Promise<RecallResponse> {
  const session = await resolveKeySession(deps, key, req.context)
  const scope = scopeFor(session, {
    ...(req.project !== undefined ? { project: req.project } : {}),
    ...(req.facets !== undefined ? { facets: req.facets } : {}),
    crossCircle: req.crossCircle,
  })
  const [candidates, subjects] = await Promise.all([
    scope.recall(req.query, {
      ...(req.limit === undefined ? {} : { limit: req.limit }),
      ...(req.facets !== undefined ? { facets: req.facets } : {}),
      crossCircle: req.crossCircle,
    }),
    req.includeSubjects ? scope.subjects() : Promise.resolve([]),
  ])
  scope.record('rest.recall', req.query, candidates)
  return { candidates, subjects }
}

const labelText = (text: string | null | undefined, max: number): string | undefined =>
  (text && clipChars(oneLine(text), max)) || undefined

// 返回接入方的当前透镜主体视图：含主场圈、关联客场圈（受限会话隐藏客场名与标识）、在场切面、可见词表与人格
export async function whoamiOf(
  deps: Deps,
  key: KeyPrincipal,
  options: {
    session?: KeySession
    context?: SessionContextInput
    project?: LifecycleProject
  } = {},
): Promise<WhoAmI> {
  const session =
    options.session ??
    (options.context ? await resolveKeySession(deps, key, options.context) : defaultSession(key))
  const access = accessForKey(key, session)
  const restricted = isRestrictedChatAccess(access)
  const activeGrants = key.circleGrants.filter((g) => g.active)
  const readCircleIds = [...access.circles.keys()]
  const primaryWriteAllowed = (access.circles.get(key.circleId)?.writeKinds.size ?? 0) > 0
  const canAutoRegister = Boolean(
    primaryWriteAllowed && normalizeProjectSlug(options.project) && !restricted,
  )

  const { persona, resolvedFacets, vocabulary } = await withCircles(
    deps.db,
    canAutoRegister ? { read: readCircleIds, write: [key.circleId] } : { read: readCircleIds },
    async (tx) => {
      const [personaRow] = session.personaId
        ? await tx
            .select({ id: personas.id, slug: personas.slug, name: personas.name })
            .from(personas)
            .where(eq(personas.id, session.personaId))
            .limit(1)
        : []

      const resolved = await resolveScopeFocusIn(tx, key, access, {
        project: options.project,
        canWritePrimary: canAutoRegister,
      })

      const vocabs = await loadCircleVocabularies(tx, readCircleIds)
      const orderedIds = [
        key.circleId,
        ...activeGrants.filter((g) => !g.isPrimary).map((g) => g.circleId),
      ]

      const dimMeta = new Map<
        string,
        { key: string; name: string; matchMode: 'exclusive' | 'additive' }
      >()
      for (const bKey of BUILTIN_FACET_KEYS) {
        const b = BUILTIN_FACET_DIMENSIONS[bKey]
        dimMeta.set(b.key, { key: b.key, name: b.name, matchMode: b.matchMode })
      }
      const termBuckets = new Map<string, Map<string, string>>()

      for (const cid of orderedIds) {
        const vocab = vocabs.get(cid)
        if (!vocab) continue
        for (const [k, mode] of vocab.dimensions) {
          if (!isBuiltinFacetKey(k) && !dimMeta.has(k)) {
            dimMeta.set(k, { key: k, name: vocab.dimensionNames.get(k) ?? k, matchMode: mode })
          }
        }
        for (const t of vocab.terms) {
          if (
            restricted &&
            cid !== key.circleId &&
            t.dimensionKey === 'project' &&
            t.autoRegistered
          ) {
            continue
          }
          if (!dimMeta.has(t.dimensionKey)) {
            dimMeta.set(t.dimensionKey, {
              key: t.dimensionKey,
              name: t.dimensionKey,
              matchMode: 'exclusive',
            })
          }
          let slugMap = termBuckets.get(t.dimensionKey)
          if (!slugMap) {
            slugMap = new Map()
            termBuckets.set(t.dimensionKey, slugMap)
          }
          if (!slugMap.has(t.slug)) slugMap.set(t.slug, t.label)
        }
      }

      const vocabList: WhoAmI['vocabulary'] = [...dimMeta.values()].map((d) => ({
        key: d.key,
        name: d.name,
        matchMode: d.matchMode,
        terms: [...(termBuckets.get(d.key)?.entries() ?? [])]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([slug, label]) => ({ slug, label })),
      }))

      return {
        persona: personaRow ?? null,
        resolvedFacets: normalizeWhen(resolved),
        vocabulary: vocabList,
      }
    },
  )

  const showOwnerName =
    !restricted && sensitivityRank(key.scopes.maxSensitivity) >= sensitivityRank('private')
  const accountName = showOwnerName
    ? labelText(key.labels?.accountName, DISPLAY_NAME_MAX)
    : undefined

  return {
    primaryCircle: {
      id: key.primaryCircle.id,
      slug: key.primaryCircle.slug,
      name: key.primaryCircle.name,
      kind: key.primaryCircle.kind,
    },
    linkedCircles: activeGrants
      .filter((g) => !g.isPrimary)
      .map((g) => ({
        id: g.circleId,
        slug: restricted ? null : g.circleSlug,
        name: restricted ? null : g.circleName,
        kind: g.circleKind,
        mode: g.mode,
      })),
    ...(accountName !== undefined ? { accountName } : {}),
    client: {
      id: key.client.id,
      circleId: key.circleId,
      slug: key.client.slug,
      name: key.client.name,
      runtimeFamily: key.client.runtimeFamily,
      ownerAccountId: key.client.ownerAccountId,
      defaultPersonaId: key.client.defaultPersonaId,
      config: key.client.config,
    },
    persona,
    contextFacets: normalizeWhen(key.contextFacets),
    resolvedFacets,
    vocabulary,
    scopes: key.scopes,
  }
}
