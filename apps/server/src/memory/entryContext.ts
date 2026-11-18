import type { CircleKind, MemberRole } from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import { consoleAccess, type Access } from '../access/access'
import { accessForKey, defaultSession, type KeySession } from '../access/session'
import { memberRole } from '../auth/middleware'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { circles } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { MemoryError } from './errors'
import { EntryService } from './service'

export interface EntryContext {
  db: Db
  access: Access
  masterKey: MasterKey | null
  actor: { keyId?: string; accountId?: string }
  onChanged?: (circleId: string, entryId: string) => void
  allowCredentialRefs?: boolean
  listSecret?: boolean
  maskSecret?: boolean
  secretRead?: 'explicit' | 'audited'
  eventContext?: Record<string, unknown>
  circleOwner?: boolean
}

export interface ConsoleCircleAccess {
  circleId: string
  circleSlug: string
  circleName: string
  circleKind: CircleKind
  defaultRealms: string[]
  role: MemberRole
  access: Access
}

export async function consoleCircleFor(
  deps: Pick<Deps, 'db'>,
  accountId: string,
  circleId: string,
): Promise<ConsoleCircleAccess | null> {
  const [role, circleRows] = await Promise.all([
    memberRole(deps as Deps, circleId, accountId),
    deps.db
      .select({
        id: circles.id,
        slug: circles.slug,
        name: circles.name,
        kind: circles.kind,
        defaultFacets: circles.defaultFacets,
      })
      .from(circles)
      .where(eq(circles.id, circleId))
      .limit(1),
  ])
  const circle = circleRows[0]
  if (!circle || !role) return null
  const defaultRealms = [...(circle.defaultFacets?.realm ?? [])]
  const access = consoleAccess(circle.id, circle.kind, role, accountId, defaultRealms)
  return {
    circleId: circle.id,
    circleSlug: circle.slug,
    circleName: circle.name,
    circleKind: circle.kind,
    defaultRealms,
    role,
    access,
  }
}

export async function consoleRoleFor(
  deps: Pick<Deps, 'db'>,
  accountId: string,
  circleId: string,
): Promise<MemberRole> {
  const role = await memberRole(deps as Deps, circleId, accountId)
  if (!role) throw new MemoryError(403, '无权访问此记忆圈')
  return role
}

export function entryServiceForKey(
  deps: Pick<Deps, 'db' | 'masterKey' | 'jobs'>,
  key: KeyPrincipal,
  session: KeySession = defaultSession(key),
  options: Pick<EntryContext, 'maskSecret' | 'eventContext' | 'allowCredentialRefs'> = {},
): EntryService {
  return new EntryService({
    db: deps.db,
    access: accessForKey(key, session),
    masterKey: deps.masterKey,
    actor: { keyId: key.keyId },
    ...(deps.jobs
      ? {
          onChanged: (circleId: string, entryId: string) =>
            deps.jobs!.enqueueEmbed(circleId, entryId),
        }
      : {}),
    secretRead: 'audited',
    ...options,
  })
}

export async function entryServiceForConsole(
  deps: Pick<Deps, 'db' | 'masterKey' | 'jobs'>,
  circleId: string,
  accountId: string,
  resolved?: ConsoleCircleAccess,
): Promise<EntryService> {
  const target = resolved ?? (await consoleCircleFor(deps, accountId, circleId))
  if (!target) throw new MemoryError(403, '无权访问此记忆圈')
  return new EntryService({
    db: deps.db,
    access: target.access,
    masterKey: deps.masterKey,
    actor: { accountId },
    ...(deps.jobs
      ? { onChanged: (cId: string, entryId: string) => deps.jobs!.enqueueEmbed(cId, entryId) }
      : {}),
    listSecret: target.access.circles.get(circleId)?.canReadSecret ?? false,
    secretRead: 'explicit',
    circleOwner: target.role === 'owner',
  })
}

export async function consoleMemberFor(
  deps: Pick<Deps, 'db' | 'masterKey' | 'jobs'>,
  circleId: string,
  accountId: string,
): Promise<{ role: MemberRole; service: EntryService; resolved: ConsoleCircleAccess }> {
  const resolved = await consoleCircleFor(deps, accountId, circleId)
  if (!resolved) throw new MemoryError(403, '无权访问此记忆圈')
  return {
    role: resolved.role,
    resolved,
    service: await entryServiceForConsole(deps, circleId, accountId, resolved),
  }
}
