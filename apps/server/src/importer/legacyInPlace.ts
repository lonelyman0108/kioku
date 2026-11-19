import {
  LEGACY_SCHEMA,
  type LegacyUpgradeResult,
  type LegacyUpgradeSummary,
} from '@kioku/contracts'
import { getTableName, is, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { PgTable } from 'drizzle-orm/pg-core'

import type { MasterKey } from '../crypto/keyring'
import type { Db, Tx } from '../db/client'
import { applyMigrations, lockMigrations, migrationStateIn } from '../db/migrate'
import * as schema from '../db/schema'
import {
  applyLegacyMigration,
  planLegacyMigration,
  readLegacyDatabaseIn,
  type LegacyMigrationPlanSummary,
} from './kiokuLegacy'

// 就地升级：库还是记忆圈重构之前的结构时，在同一个库里迁移，不用新建库、不改连接地址。整件事在一个事务里：
// 读旧表 → 只把 Kioku 自己的旧对象（表、类型、触发器函数、全文检索配置、迁移记录）移进 kioku_legacy 保留 →
// 在 public 里执行这个版本的迁移 → 规划并写入（含旧访问密钥哈希）。哪一步失败都整体撤销，库保持原样。
// 同库里其他应用建的无关表、以及扩展自带的词典与配置（例如 zhparser 的 chinese_zh）都不动。
// 预览（apply 为 false）把这一整套跑完再回滚，统计与执行时一致

// pg-boss 的旧任务表一起挪开：旧任务的名字和数据新版本不认得，留在原处会被新版本的后台任务读到
const LEGACY_PGBOSS_SCHEMA = `${LEGACY_SCHEMA}_pgboss`

// Kioku 重构之前（v0.1 到 v0.5）在 public 里建过的全部对象：白名单只移走它们，不动同库里的其他表与系统对象
const LEGACY_TABLES = [
  'accounts',
  'account_links',
  'api_keys',
  'app_group_personas',
  'apps',
  'conversation_turns',
  'conversations',
  'credential_events',
  'credential_providers',
  'credentials',
  'device_grants',
  'dream_marks',
  'dream_runs',
  'dream_suggestions',
  'extraction_runs',
  'login_attempts',
  'memories',
  'memory_credential_refs',
  'memory_embeddings',
  'memory_events',
  'memory_glossary',
  'memory_recall_stats',
  'personas',
  'recall_event_hits',
  'recall_events',
  'sessions',
  'settings',
  'space_departures',
  'space_members',
  'spaces',
  'subject_bind_attempts',
  'subject_bind_codes',
  'subject_bindings',
  'subject_identities',
  'subjects',
  'vault_connections',
] as const

const LEGACY_TYPES = [
  'account_link_purpose',
  'conversation_kind',
  'credential_provider_kind',
  'credential_source',
  'member_role',
  'memory_form',
  'memory_layer',
  'provenance',
  'sensitivity',
  'subject_kind',
  'vault_connection_status',
  'vault_disabled_reason',
  'vault_error_kind',
] as const

const LEGACY_ROUTINES = ['conversations_delete_summaries', 'memories_uri_exclusive'] as const
const LEGACY_TS_CONFIGS = ['kioku_zh'] as const

// 新基线才建、旧版没有的对象：移走旧对象后如果 public 里还留着同名对象（例如无关表撞名），基线迁移会撞上
const LEGACY_TABLE_SET = new Set<string>(LEGACY_TABLES)
const NEW_ONLY_TABLES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))
  .filter((name) => !LEGACY_TABLE_SET.has(name))
const NEW_ONLY_TYPES = ['circle_kind', 'entry_kind', 'facet_match_mode'] as const
const NEW_ONLY_ROUTINES = [
  'circles_forbid_personal_delete',
  'conversations_delete_episodes',
] as const

// 给运维看的失败：库的状态不对、缺权限、撞名等，说明可以原样给人看
export class LegacyUpgradeError extends Error {}

export interface InPlaceOptions {
  migrationsFolder: string
  masterKey: MasterKey | null
  // 旧实例的主密钥；就地升级一般和新实例是同一把，不给时用 masterKey
  legacyMasterKey?: MasterKey | null
  apply: boolean
  // 同一事务里、读旧表之前调用：升级页在这里核对旧实例的管理员
  authorize?: (tx: Tx) => Promise<void>
}

class Rollback extends Error {
  constructor(readonly result: LegacyUpgradeResult) {
    super('preview')
  }
}

export async function migrateLegacyInPlace(
  db: Db,
  options: InPlaceOptions,
): Promise<LegacyUpgradeResult> {
  const local = readMigrationFiles({ migrationsFolder: options.migrationsFolder })
  try {
    return await db.transaction(async (tx) => {
      await lockMigrations(tx)
      if ((await migrationStateIn(tx, local)) !== 'pre_baseline') {
        throw new LegacyUpgradeError('数据库不是记忆圈重构之前的结构，不需要就地升级')
      }
      await options.authorize?.(tx)
      await assertMovable(tx)

      const snapshot = await readLegacyDatabaseIn(tx)

      await moveLegacyObjects(tx)
      await applyMigrations(tx, local)

      const legacyMasterKey = options.legacyMasterKey ?? options.masterKey
      const plan = await planLegacyMigration(tx, snapshot, {
        legacyMasterKey,
        targetMasterKey: options.masterKey,
      })
      const { summary } = await applyLegacyMigration(tx, plan, {
        targetMasterKey: options.masterKey,
      })

      const result = {
        applied: options.apply,
        summary: summaryOf(summary, plan.legacyApiKeys.length),
      }
      if (!options.apply) throw new Rollback(result)
      return result
    })
  } catch (err) {
    if (err instanceof Rollback) return err.result
    throw err
  }
}

function summaryOf(summary: LegacyMigrationPlanSummary, legacyKeys: number): LegacyUpgradeSummary {
  return {
    accounts: summary.accounts,
    sharedCircles: summary.sharedCircles.map((c) => ({ name: c.name, memberCount: c.memberCount })),
    personas: summary.personas,
    personaTraits: summary.personaTraits,
    clients: summary.clients,
    groupRules: summary.groupRules,
    subjects: summary.subjects,
    conversations: summary.conversations,
    vaultConnections: summary.vaultConnections,
    credentials: summary.credentials,
    entries: summary.entries,
    legacyUris: summary.legacyUris,
    settings: summary.settings,
    legacyKeys,
    skippedDeletedMemories: summary.skippedDeletedMemories,
    skippedDeletedCredentials: summary.skippedDeletedCredentials,
    warnings: summary.warnings,
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const sqlList = (items: readonly string[]) =>
  items.map((item) => `'${item.replaceAll("'", "''")}'`).join(', ')

// 扩展自带的对象（pgvector 的类型与函数、zhparser 的解析器）留在 public，新旧表共用
const NOT_EXTENSION = (catalog: string, oid: string) =>
  `not exists (select 1 from pg_depend e where e.classid = '${catalog}'::regclass and e.objid = ${oid} and e.deptype = 'e')`

interface MovableObject {
  kind:
    'table' | 'view' | 'materialized' | 'sequence' | 'type' | 'routine' | 'ts_config' | 'ts_dict'
  name: string
  owned: boolean
}

const ALTER: Record<MovableObject['kind'], string> = {
  table: 'alter table',
  view: 'alter view',
  materialized: 'alter materialized view',
  sequence: 'alter sequence',
  type: 'alter type',
  routine: 'alter routine',
  ts_config: 'alter text search configuration',
  ts_dict: 'alter text search dictionary',
}

async function moveObjectsTo(
  tx: Tx,
  objects: readonly MovableObject[],
  target: string,
): Promise<void> {
  for (const object of objects) {
    // 函数的名字带参数列表（重载靠它区分），参数列表照原样拼，函数名单独加引号
    const paren = object.name.indexOf('(')
    const name =
      object.kind === 'routine'
        ? `${quote(object.name.slice(0, paren))}${object.name.slice(paren)}`
        : quote(object.name)
    await tx.execute(sql.raw(`${ALTER[object.kind]} public.${name} set schema ${quote(target)}`))
  }
}

// public 里属于 Kioku 旧版的表、类型、函数与全文检索配置。表带走它的索引、约束、触发器、
// 行级安全策略与列上的序列；数组类型跟着元素类型走，表的行类型跟着表走
async function legacyObjects(tx: Tx): Promise<MovableObject[]> {
  const rows = await tx.execute<{ kind: MovableObject['kind']; name: string; owned: boolean }>(
    sql.raw(`
    select 'table' as kind, c.relname as name, pg_has_role(c.relowner, 'USAGE') as owned
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'f')
      and not c.relispartition
      and c.relname in (${sqlList(LEGACY_TABLES)})
      and ${NOT_EXTENSION('pg_class', 'c.oid')}
    union all
    select 'type', t.typname, pg_has_role(t.typowner, 'USAGE')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typtype in ('e', 'd')
      and t.typname in (${sqlList(LEGACY_TYPES)})
      and ${NOT_EXTENSION('pg_type', 't.oid')}
    union all
    select 'routine', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_has_role(p.proowner, 'USAGE')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (${sqlList(LEGACY_ROUTINES)})
      and ${NOT_EXTENSION('pg_proc', 'p.oid')}
    union all
    select 'ts_config', c.cfgname, pg_has_role(c.cfgowner, 'USAGE')
    from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace
    where n.nspname = 'public'
      and c.cfgname in (${sqlList(LEGACY_TS_CONFIGS)})
      and ${NOT_EXTENSION('pg_ts_config', 'c.oid')}`),
  )
  return [...rows]
}

// 供测试清库用：移走 public 里当前角色拥有且不属于扩展的所有对象（兼容旧结构与新结构，不动系统配置如 chinese_zh）
export async function moveOwnedPublicObjects(tx: Tx, target: string): Promise<void> {
  const rows = await tx.execute<{ kind: MovableObject['kind']; name: string; owned: boolean }>(
    sql.raw(`
    select case c.relkind when 'v' then 'view' when 'm' then 'materialized' when 'S' then 'sequence'
             else 'table' end as kind,
           c.relname as name, pg_has_role(c.relowner, 'USAGE') as owned
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'f', 'v', 'm', 'S')
      and not c.relispartition
      and ${NOT_EXTENSION('pg_class', 'c.oid')}
      and not (c.relkind = 'S' and exists (
        select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid
          and d.deptype in ('a', 'i')))
    union all
    select 'type', t.typname, pg_has_role(t.typowner, 'USAGE')
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and (t.typtype in ('e', 'd')
        or (t.typtype = 'c' and exists (select 1 from pg_class r where r.oid = t.typrelid and r.relkind = 'c')))
      and ${NOT_EXTENSION('pg_type', 't.oid')}
    union all
    select 'routine', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
           pg_has_role(p.proowner, 'USAGE')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and ${NOT_EXTENSION('pg_proc', 'p.oid')}
    union all
    select 'ts_config', c.cfgname, pg_has_role(c.cfgowner, 'USAGE')
    from pg_ts_config c join pg_namespace n on n.oid = c.cfgnamespace
    where n.nspname = 'public' and ${NOT_EXTENSION('pg_ts_config', 'c.oid')}
    union all
    select 'ts_dict', t.dictname, pg_has_role(t.dictowner, 'USAGE')
    from pg_ts_dict t join pg_namespace n on n.oid = t.dictnamespace
    where n.nspname = 'public' and ${NOT_EXTENSION('pg_ts_dict', 't.oid')}`),
  )
  await moveObjectsTo(
    tx,
    rows.filter((r) => r.owned),
    target,
  )
}

async function newObjectCollisions(tx: Tx): Promise<string[]> {
  const rows = await tx.execute<{ name: string }>(
    sql.raw(`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'f', 'v', 'm')
      and c.relname in (${sqlList(NEW_ONLY_TABLES)})
      and ${NOT_EXTENSION('pg_class', 'c.oid')}
    union all
    select t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype in ('e', 'd', 'c')
      and t.typname in (${sqlList(NEW_ONLY_TYPES)})
      and ${NOT_EXTENSION('pg_type', 't.oid')}
    union all
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (${sqlList(NEW_ONLY_ROUTINES)})
      and ${NOT_EXTENSION('pg_proc', 'p.oid')}`),
  )
  return rows.map((r) => r.name)
}

async function assertMovable(tx: Tx): Promise<void> {
  const [priv] = await tx.execute<{ can_create: boolean }>(
    sql`select has_database_privilege(current_database(), 'CREATE') as can_create`,
  )
  if (!priv?.can_create) {
    throw new LegacyUpgradeError(
      '当前数据库角色没有在当前库创建 schema 的权限（CREATE），无法创建 kioku_legacy：授予 CREATE 权限后重试，或改用新建空库 + kioku-ctl migrate-legacy --from-db 迁入',
    )
  }

  const [taken] = await tx.execute<{ legacy: boolean; pgboss: boolean }>(sql`
    select to_regnamespace(${LEGACY_SCHEMA}) is not null as legacy,
           to_regnamespace(${LEGACY_PGBOSS_SCHEMA}) is not null as pgboss`)
  if (taken?.legacy || taken?.pgboss) {
    const name = taken.legacy ? LEGACY_SCHEMA : LEGACY_PGBOSS_SCHEMA
    throw new LegacyUpgradeError(
      `库里已经有 ${name} schema：先确认里面的内容，改名或删掉之后再升级`,
    )
  }

  const foreign = (await legacyObjects(tx)).filter((o) => !o.owned)
  if (foreign.length) {
    const names = foreign
      .slice(0, 5)
      .map((o) => o.name)
      .join('、')
    throw new LegacyUpgradeError(
      `public 里有 ${foreign.length} 个旧版对象不属于当前数据库角色（${names}${foreign.length > 5 ? ' 等' : ''}），无法移走：改成当前角色所有后重试`,
    )
  }

  const [drizzle] = await tx.execute<{ owned: boolean }>(sql`
    select pg_has_role(c.relowner, 'USAGE') as owned
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations'`)
  if (drizzle && !drizzle.owned) {
    throw new LegacyUpgradeError(
      'drizzle.__drizzle_migrations 不属于当前数据库角色，无法移走：改成当前角色所有后重试',
    )
  }

  const [pgboss] = await tx.execute<{ owned: boolean }>(sql`
    select pg_has_role(nspowner, 'USAGE') as owned from pg_namespace where nspname = 'pgboss'`)
  if (pgboss && !pgboss.owned) {
    throw new LegacyUpgradeError(
      '库里的 pgboss schema 不属于当前数据库角色，无法移走：改成当前角色所有或清理后重试',
    )
  }

  const collisions = await newObjectCollisions(tx)
  if (collisions.length) {
    const names = collisions.slice(0, 5).join('、')
    throw new LegacyUpgradeError(
      `public 里已有与新版重名的对象（${names}${collisions.length > 5 ? ' 等' : ''}）：移走或改名后重试`,
    )
  }
}

async function moveLegacyObjects(tx: Tx): Promise<void> {
  await tx.execute(sql.raw(`create schema ${quote(LEGACY_SCHEMA)}`))
  await moveObjectsTo(tx, await legacyObjects(tx), LEGACY_SCHEMA)
  // 旧的迁移记录留在 kioku_legacy 里，之后 drizzle schema 里重新建一张只记这个版本的迁移
  const [drizzle] = await tx.execute<{ exists: boolean }>(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
  )
  if (drizzle?.exists) {
    await tx.execute(
      sql.raw(`alter table drizzle.__drizzle_migrations set schema ${quote(LEGACY_SCHEMA)}`),
    )
  }
  const [pgboss] = await tx.execute<{ exists: boolean }>(
    sql`select to_regnamespace('pgboss') is not null as exists`,
  )
  if (pgboss?.exists) {
    await tx.execute(sql.raw(`alter schema pgboss rename to ${quote(LEGACY_PGBOSS_SCHEMA)}`))
  }
}
