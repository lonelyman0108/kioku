import { ENTRY_KINDS, type CircleKind, type EntryKind, type MemberRole } from '@kioku/contracts'
import { eq } from 'drizzle-orm'

import { consoleAccess, type Access, type CircleAccess } from '../access/access'
import { accessForKey, defaultSession, type KeySession } from '../access/session'
import { memberRole } from '../auth/middleware'
import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { circleMembers, circles } from '../db/schema'
import type { Deps, KeyPrincipal } from '../http/env'
import { MemoryError } from './errors'
import { EntryService } from './service'

export interface EntryContext {
  db: Db
  access: Access
  // 管理界面跨圈双链邻居解析权限：仅用于单条记忆详情的出链与反向链接展示，不影响单圈列表与检索
  neighborAccess?: Access
  masterKey: MasterKey | null
  actor: { keyId?: string; accountId?: string }
  onChanged?: (circleId: string, entryId: string) => void
  allowCredentialRefs?: boolean
  listSecret?: boolean
  maskSecret?: boolean
  secretRead?: 'explicit' | 'audited'
  eventContext?: Record<string, unknown>
  circleOwner?: boolean
  takeReplayShortId?: (() => string | undefined) | undefined
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
  options: Pick<
    EntryContext,
    'maskSecret' | 'eventContext' | 'allowCredentialRefs' | 'takeReplayShortId'
  > = {},
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

async function consoleNeighborAccess(
  deps: Pick<Deps, 'db'>,
  accountId: string,
  target: ConsoleCircleAccess,
): Promise<Access> {
  const rows = await deps.db
    .select({ id: circles.id, kind: circles.kind })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(eq(circleMembers.accountId, accountId))
  const allKinds = new Set<EntryKind>(ENTRY_KINDS)
  const circleMap = new Map<string, CircleAccess>(target.access.circles)
  for (const r of rows) {
    if (circleMap.has(r.id)) continue
    circleMap.set(r.id, {
      circleId: r.id,
      circleKind: r.kind,
      isPrimary: false,
      readKinds: allKinds,
      writeKinds: new Set(),
      maxSensitivity: 'private',
      canReadSecret: false,
    })
  }
  return { ...target.access, circles: circleMap }
}

export async function entryServiceForConsole(
  deps: Pick<Deps, 'db' | 'masterKey' | 'jobs'>,
  circleId: string,
  accountId: string,
  resolved?: ConsoleCircleAccess,
): Promise<EntryService> {
  const target = resolved ?? (await consoleCircleFor(deps, accountId, circleId))
  if (!target) throw new MemoryError(403, '无权访问此记忆圈')
  const neighborAccess = await consoleNeighborAccess(deps, accountId, target)
  return new EntryService({
    db: deps.db,
    access: target.access,
    neighborAccess,
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

export async function consoleAllCirclesAccessFor(
  deps: Pick<Deps, 'db'>,
  circleId: string,
  accountId: string,
  resolved?: ConsoleCircleAccess,
): Promise<Access> {
  const target = resolved ?? (await consoleCircleFor(deps, accountId, circleId))
  if (!target) throw new MemoryError(403, '无权访问此记忆圈')
  return consoleNeighborAccess(deps, accountId, target)
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
