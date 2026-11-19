import {
  ClientConfig,
  type ClientGroupRule,
  type ClientGroupRuleView,
  type ClientInfo,
} from '@kioku/contracts'
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'

import type { Tx } from '../db/client'
import {
  accounts,
  apiKeys,
  circleMembers,
  clientGroupRules,
  clients,
  personas,
  subjects,
} from '../db/schema'
import { CLIENT_ADVANCED_FIELD, withoutClientGuidance } from '../settings/advanced'

export function toClientInfo(row: typeof clients.$inferSelect): ClientInfo {
  return {
    id: row.id,
    circleId: row.circleId,
    slug: row.slug,
    name: row.name,
    runtimeFamily: row.runtimeFamily,
    ownerAccountId: row.ownerAccountId,
    defaultPersonaId: row.defaultPersonaId,
    config: ClientConfig.parse(row.config),
  }
}

export async function listClients(tx: Tx): Promise<ClientInfo[]> {
  const rows = await tx.select().from(clients).orderBy(asc(clients.name), asc(clients.id))
  return rows.map(toClientInfo)
}

export type CreateClientResult =
  { ok: true; client: ClientInfo } | { ok: false; reason: 'no-persona' | 'slug-taken' }

export async function createClient(
  tx: Tx,
  input: {
    circleId: string
    ownerAccountId: string
    slug: string
    name: string
    runtimeFamily: string
    defaultPersonaId?: string | null
    config?: ClientConfig
  },
): Promise<CreateClientResult> {
  if (input.defaultPersonaId) {
    const [persona] = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.id, input.defaultPersonaId))
      .limit(1)
    if (!persona) return { ok: false, reason: 'no-persona' }
  }
  const [created] = await tx
    .insert(clients)
    .values({
      circleId: input.circleId,
      slug: input.slug,
      name: input.name,
      runtimeFamily: input.runtimeFamily,
      ownerAccountId: input.ownerAccountId,
      defaultPersonaId: input.defaultPersonaId ?? null,
      config: input.config ?? { personMemoryMode: 'strict' },
    })
    .onConflictDoNothing({ target: [clients.circleId, clients.slug] })
    .returning()
  if (!created) return { ok: false, reason: 'slug-taken' }
  return { ok: true, client: toClientInfo(created) }
}

export type UpdateClientResult =
  | { ok: true; client: ClientInfo }
  | { ok: false; reason: 'no-client' | 'no-persona' | 'invalid-owner' }

// 更新接入实例：转让 ownerAccountId 时同步吊销该实例下所有有效访问密钥并剥离 prompts.guidance
export async function updateClient(
  tx: Tx,
  input: {
    circleId: string
    clientId: string
    name?: string
    ownerAccountId?: string
    defaultPersonaId?: string | null
    config?: ClientConfig
  },
): Promise<UpdateClientResult> {
  const [existing] = await tx
    .select()
    .from(clients)
    .where(and(eq(clients.id, input.clientId), eq(clients.circleId, input.circleId)))
    .for('update')
  if (!existing) return { ok: false, reason: 'no-client' }

  if (input.defaultPersonaId) {
    const [persona] = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(eq(personas.id, input.defaultPersonaId))
      .limit(1)
    if (!persona) return { ok: false, reason: 'no-persona' }
  }

  const transferring =
    input.ownerAccountId !== undefined && input.ownerAccountId !== existing.ownerAccountId
  if (transferring) {
    const [nextOwner] = await tx
      .select({ role: circleMembers.role, disabledAt: accounts.disabledAt })
      .from(circleMembers)
      .innerJoin(accounts, eq(accounts.id, circleMembers.accountId))
      .where(
        and(
          eq(circleMembers.circleId, input.circleId),
          eq(circleMembers.accountId, input.ownerAccountId!),
        ),
      )
      .limit(1)
    if (!nextOwner || nextOwner.disabledAt || nextOwner.role === 'viewer') {
      return { ok: false, reason: 'invalid-owner' }
    }
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.clientId, existing.id), isNull(apiKeys.revokedAt)))
  }

  // 修改 config 时保留挂在内部的 advanced（高级设置覆盖），仅在转让所有权时清掉 prompts.guidance
  let nextConfigExpr: ReturnType<typeof sql> | ClientConfig | undefined
  if (input.config !== undefined) {
    const existingRaw = existing.config as Record<string, unknown> | null
    const existingAdvanced =
      existingRaw && typeof existingRaw === 'object'
        ? existingRaw[CLIENT_ADVANCED_FIELD]
        : undefined
    const mergedConfig: Record<string, unknown> = { ...input.config }
    if (existingAdvanced !== undefined) {
      if (transferring && existingAdvanced && typeof existingAdvanced === 'object') {
        const cleaned = { ...(existingAdvanced as Record<string, unknown>) }
        delete cleaned['prompts.guidance']
        mergedConfig[CLIENT_ADVANCED_FIELD] = cleaned
      } else {
        mergedConfig[CLIENT_ADVANCED_FIELD] = existingAdvanced
      }
    }
    nextConfigExpr = mergedConfig as unknown as ClientConfig
  } else if (transferring) {
    nextConfigExpr = withoutClientGuidance
  }

  const [updated] = await tx
    .update(clients)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.ownerAccountId !== undefined ? { ownerAccountId: input.ownerAccountId } : {}),
      ...(input.defaultPersonaId !== undefined ? { defaultPersonaId: input.defaultPersonaId } : {}),
      ...(nextConfigExpr !== undefined ? { config: nextConfigExpr } : {}),
      updatedAt: new Date(),
    })
    .where(eq(clients.id, existing.id))
    .returning()

  return { ok: true, client: toClientInfo(updated!) }
}

export async function deleteClient(tx: Tx, clientId: string): Promise<boolean> {
  const gone = await tx
    .delete(clients)
    .where(eq(clients.id, clientId))
    .returning({ id: clients.id })
  return gone.length > 0
}

export async function listClientGroupRules(
  tx: Tx,
  circleId: string,
  clientId: string,
): Promise<ClientGroupRuleView[] | null> {
  const [client] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.circleId, circleId)))
    .limit(1)
  if (!client) return null
  const rows = await tx
    .select({
      groupSubjectId: clientGroupRules.groupSubjectId,
      personaId: clientGroupRules.personaId,
      isolateGroupMemory: clientGroupRules.isolateGroupMemory,
      groupName: subjects.displayName,
    })
    .from(clientGroupRules)
    .innerJoin(subjects, eq(subjects.id, clientGroupRules.groupSubjectId))
    .where(eq(clientGroupRules.clientId, clientId))
    .orderBy(asc(clientGroupRules.createdAt), asc(clientGroupRules.groupSubjectId))
  return rows
}

export type ReplaceGroupRulesResult =
  | { ok: true; rules: ClientGroupRuleView[] }
  | { ok: false; reason: 'no-client' | 'duplicate-group' | 'no-group' | 'not-group' | 'no-persona' }

export async function replaceClientGroupRules(
  tx: Tx,
  circleId: string,
  clientId: string,
  rules: readonly ClientGroupRule[],
): Promise<ReplaceGroupRulesResult> {
  const [client] = await tx
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.circleId, circleId)))
    .for('update')
  if (!client) return { ok: false, reason: 'no-client' }

  const groupIds = rules.map((r) => r.groupSubjectId)
  if (new Set(groupIds).size !== groupIds.length) {
    return { ok: false, reason: 'duplicate-group' }
  }

  if (groupIds.length) {
    const foundGroups = await tx
      .select({ id: subjects.id, kind: subjects.kind })
      .from(subjects)
      .where(inArray(subjects.id, groupIds))
      .for('key share')
    if (foundGroups.length !== groupIds.length) {
      return { ok: false, reason: 'no-group' }
    }
    if (foundGroups.some((g) => g.kind !== 'group')) {
      return { ok: false, reason: 'not-group' }
    }
  }

  const personaIds = [
    ...new Set(rules.map((r) => r.personaId).filter((id): id is string => id !== null)),
  ]
  if (personaIds.length) {
    const validPersonas = await tx
      .select({ id: personas.id })
      .from(personas)
      .where(inArray(personas.id, personaIds))
      .for('key share')
    if (validPersonas.length !== personaIds.length) {
      return { ok: false, reason: 'no-persona' }
    }
  }

  await tx
    .delete(clientGroupRules)
    .where(
      and(
        eq(clientGroupRules.clientId, clientId),
        groupIds.length ? notInArray(clientGroupRules.groupSubjectId, groupIds) : undefined,
      ),
    )
  if (rules.length) {
    await tx
      .insert(clientGroupRules)
      .values(
        rules.map((r) => ({
          circleId,
          clientId,
          groupSubjectId: r.groupSubjectId,
          personaId: r.personaId,
          isolateGroupMemory: r.isolateGroupMemory,
        })),
      )
      .onConflictDoUpdate({
        target: [clientGroupRules.clientId, clientGroupRules.groupSubjectId],
        set: {
          personaId: sql`excluded.persona_id`,
          isolateGroupMemory: sql`excluded.isolate_group_memory`,
          updatedAt: new Date(),
        },
        setWhere: sql`${clientGroupRules.personaId} is distinct from excluded.persona_id or ${clientGroupRules.isolateGroupMemory} is distinct from excluded.isolate_group_memory`,
      })
  }

  return { ok: true, rules: (await listClientGroupRules(tx, circleId, clientId)) ?? [] }
}
