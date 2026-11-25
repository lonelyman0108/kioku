import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'

import {
  DATABASE_EXTENSIONS,
  type DatabaseCheck,
  type DatabaseConnection,
  type DatabaseExtension,
  type DatabaseFailure,
  type DatabaseProblem,
  type DatabaseSummary,
  type ExistingData,
  type ExtensionState,
  type ProvisionProblem,
} from '@kioku/contracts'
import { DrizzleQueryError, getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import postgres from 'postgres'

import { postgresOptions } from './client'
import { instanceContent, isInitialized } from './instance'
import { migrationState } from './migrate'
import * as schema from './schema'

// 初始化页数据库检查与可选超级用户代建：对外只暴露类别，不透出连接串与底层驱动错误细节
const CONNECT_TIMEOUT_SECONDS = 10
const STATEMENT_TIMEOUT_MS = 10_000

function open(url: string): postgres.Sql {
  return postgres(
    url,
    postgresOptions({ max: 1, connect_timeout: CONNECT_TIMEOUT_SECONDS, idle_timeout: 1 }),
  )
}

export function connectionUrl(c: DatabaseConnection): string {
  const host = c.host.includes(':') ? `[${c.host}]` : c.host
  const enc = encodeURIComponent
  return `postgres://${enc(c.username)}:${enc(c.password)}@${host}:${c.port}/${enc(c.database)}?sslmode=${c.ssl}`
}

export function summarize(url: string): DatabaseSummary | null {
  try {
    const { options } = postgres(url, postgresOptions({ max: 1 }))
    const ssl = options.ssl as unknown
    return {
      host: String(options.host[0] ?? ''),
      port: Number(options.port[0] ?? 5432),
      database: String(options.database ?? ''),
      username: String(options.user ?? ''),
      passwordSet: Boolean(options.pass),
      ssl: ssl === false ? 'disable' : typeof ssl === 'string' ? ssl : 'require',
    }
  } catch {
    return null
  }
}

const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',
  'EPIPE',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
])

export function failureOf(err: unknown): DatabaseFailure {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'unknown'
  if (UNREACHABLE.has(code)) return 'unreachable'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'host_not_found'
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === '57014') return 'timeout'
  if (code === '28P01' || code.startsWith('SASL_') || code === 'AUTH_TYPE_NOT_IMPLEMENTED') {
    return 'auth_failed'
  }
  if (code === '28000') return 'not_allowed'
  if (code === '3D000') return 'database_missing'
  if (code === '42501') return 'permission_denied'
  if (code === 'SSL_NOT_SUPPORTED') return 'ssl_unsupported'
  if (/^ERR_(TLS|SSL)_|CERT|SELF_SIGNED|UNABLE_TO_/.test(code)) return 'ssl_failed'
  if (code === '53300' || code === '57P03') return 'busy'
  if (code === '57P01' || code === '57P02' || code.startsWith('08')) return 'unreachable'
  return 'unknown'
}

const NOT_TRANSIENT = new Set<DatabaseFailure>(['permission_denied', 'unknown'])

export function transientFailure(err: unknown): DatabaseFailure | null {
  const candidates = [err, pgErrorOf(err), (pgErrorOf(err) as { cause?: unknown } | null)?.cause]
  for (const candidate of candidates) {
    const kind = failureOf(candidate)
    if (!NOT_TRANSIENT.has(kind)) return kind
  }
  return null
}

function pgErrorOf(err: unknown): unknown {
  return err instanceof DrizzleQueryError ? err.cause : err
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

const OWN_TABLES = new Set(
  (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table)),
)

export interface DatabaseFacts {
  role: { name: string; superuser: boolean }
  extensions: { name: DatabaseExtension; state: ExtensionState }[]
  existing: ExistingData
  accounts: number | null
  unrelatedTables: number
}

// 单人自托管不启用行级安全，普通角色与超级用户均可接入；仅核对必需扩展与迁移状态
export function problemsOf(facts: DatabaseFacts): DatabaseProblem[] {
  const problems: DatabaseProblem[] = []
  for (const { name, state } of facts.extensions) {
    if (state === 'available') problems.push({ code: 'extension_not_installed', extension: name })
    if (state === 'missing') problems.push({ code: 'extension_missing', extension: name })
  }
  if (facts.existing === 'pre_baseline' || facts.existing === 'newer') {
    problems.push({ code: facts.existing })
  }
  return problems
}

export function assess(facts: DatabaseFacts): DatabaseCheck {
  const problems = problemsOf(facts)
  return { failure: null, ...facts, problems, ready: problems.length === 0 }
}

export function failedCheck(failure: DatabaseFailure): DatabaseCheck {
  return {
    failure,
    role: null,
    extensions: [],
    existing: null,
    accounts: null,
    unrelatedTables: 0,
    problems: [{ code: 'connection' }],
    ready: false,
  }
}

function inspectFailedCheck(err: unknown): DatabaseCheck {
  const code = errorCode(pgErrorOf(err))
  return {
    ...failedCheck('unknown'),
    failure: null,
    problems: [{ code: code === '42501' ? 'insufficient_privilege' : 'inspect_failed' }],
  }
}

export function isFatal(check: DatabaseCheck): boolean {
  return check.problems.some((p) => p.code !== 'connection')
}

export async function probeDatabase(url: string, migrationsFolder: string): Promise<DatabaseCheck> {
  const client = open(url)
  let connected = false
  try {
    const facts = await client.begin('read only', async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
      connected = true
      return gatherFacts(tx, migrationsFolder)
    })
    return assess(facts)
  } catch (err) {
    console.warn('数据库检查失败', { code: errorCode(err) })
    if (!connected) return failedCheck(failureOf(err))
    const kind = transientFailure(err)
    return kind ? failedCheck(kind) : inspectFailedCheck(err)
  } finally {
    await client.end({ timeout: 1 }).catch(() => {})
  }
}

async function gatherFacts(
  client: postgres.TransactionSql,
  migrationsFolder: string,
): Promise<DatabaseFacts> {
  const [role] = await client<{ name: string; superuser: boolean }[]>`
    select rolname as name, rolsuper as superuser
    from pg_roles where rolname = current_user`
  if (!role) throw Object.assign(new Error('无法读取当前角色'), { code: 'unknown' })
  const available = await client<{ name: string; installed: string | null }[]>`
    select a.name, e.extversion as installed
    from pg_available_extensions a left join pg_extension e on e.extname = a.name
    where a.name in ('vector', 'zhparser')`
  const extensions = DATABASE_EXTENSIONS.map((name) => {
    const row = available.find((r) => r.name === name)
    const state: ExtensionState = !row ? 'missing' : row.installed ? 'installed' : 'available'
    return { name, state }
  })
  const migrations = await migrationState(client, migrationsFolder)
  const content =
    migrations === 'known' ? await instanceContent((query) => client.unsafe(query)) : null
  const existing: ExistingData =
    migrations === 'none'
      ? 'empty'
      : migrations !== 'known'
        ? migrations
        : isInitialized(content!)
          ? 'kioku'
          : 'migrated'
  const tables = await client<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema', 'drizzle', 'pgboss')
      and n.nspname not like 'pg\\_%'
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
      )`
  const unrelatedTables = tables.filter(
    (t) => !(t.schema === 'public' && OWN_TABLES.has(t.name)),
  ).length
  return {
    role,
    extensions,
    existing,
    accounts: content?.accounts ?? null,
    unrelatedTables,
  }
}

const EXTENSION_MISSING_CODES = new Set(['0A000', '58P01'])

export class ProvisionError extends Error {
  constructor(
    readonly problem: ProvisionProblem,
    readonly detail: { failure?: DatabaseFailure; extensions?: DatabaseExtension[] } = {},
  ) {
    super(problem)
  }
}

export function scramVerifier(password: string): string {
  const salt = randomBytes(16)
  const iterations = 4096
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}$${b64(serverKey)}`
}

export interface Provisioned {
  url: string
  undo: () => Promise<void>
}

export async function provisionDatabase(request: {
  superuser: DatabaseConnection
  role: string
  database: string
}): Promise<Provisioned> {
  const { superuser, role, database } = request
  const admin = open(connectionUrl(superuser))
  const created = { role: false, database: false }
  const undo = async () => {
    const cleanup = open(connectionUrl(superuser))
    try {
      if (created.database)
        await cleanup.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      if (created.role) await cleanup.unsafe(`DROP ROLE IF EXISTS "${role}"`)
    } finally {
      await cleanup.end({ timeout: 1 }).catch(() => {})
    }
  }
  try {
    let me: { superuser: boolean } | undefined
    try {
      ;[me] = await admin<{ superuser: boolean }[]>`
        select rolsuper as superuser from pg_roles where rolname = current_user`
    } catch (err) {
      console.warn('超级用户连接失败', { code: errorCode(err) })
      throw new ProvisionError('connection', { failure: failureOf(err) })
    }
    if (!me?.superuser) throw new ProvisionError('not_superuser')
    const available = await admin<{ name: DatabaseExtension }[]>`
      select name from pg_available_extensions where name in ('vector', 'zhparser')`
    const missing = DATABASE_EXTENSIONS.filter((n) => !available.some((a) => a.name === n))
    if (missing.length) throw new ProvisionError('extension_missing', { extensions: missing })
    if ((await admin`select 1 from pg_roles where rolname = ${role}`).length) {
      throw new ProvisionError('role_exists')
    }
    if ((await admin`select 1 from pg_database where datname = ${database}`).length) {
      throw new ProvisionError('database_exists')
    }

    const password = randomBytes(24).toString('hex')
    await admin.unsafe(
      `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${scramVerifier(password)}'`,
    )
    created.role = true
    await admin.unsafe(`CREATE DATABASE "${database}" OWNER "${role}"`)
    created.database = true
    const inside = open(connectionUrl({ ...superuser, database }))
    try {
      for (const name of DATABASE_EXTENSIONS) {
        await inside.unsafe(`CREATE EXTENSION IF NOT EXISTS ${name}`)
      }
    } catch (err) {
      console.warn('安装扩展失败', { code: errorCode(err) })
      if (EXTENSION_MISSING_CODES.has(errorCode(err))) {
        throw new ProvisionError('extension_missing', { extensions: [...DATABASE_EXTENSIONS] })
      }
      throw new ProvisionError('failed', { failure: failureOf(err) })
    } finally {
      await inside.end({ timeout: 1 }).catch(() => {})
    }
    return {
      url: connectionUrl({ ...superuser, username: role, password, database }),
      undo,
    }
  } catch (err) {
    if (created.role || created.database) {
      await undo().catch((cleanupErr: unknown) =>
        console.error('删除代建的库与角色失败', { code: errorCode(cleanupErr) }),
      )
    }
    if (err instanceof ProvisionError) throw err
    console.warn('代建数据库失败', { code: errorCode(err) })
    throw new ProvisionError('failed', { failure: failureOf(err) })
  } finally {
    await admin.end({ timeout: 1 }).catch(() => {})
  }
}
