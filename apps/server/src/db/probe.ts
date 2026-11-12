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
import { migrationState } from './migrate'
import * as schema from './schema'

// 初始化页的数据库检查与超级用户代建。连接只为这一次检查开，用完就关；
// 报给人看的只有类别（DatabaseFailure），驱动的说明与连接串不出这个文件，日志也只记错误的 code

// 检查最多等这么久：连不上、语句卡住都按超时算
const CONNECT_TIMEOUT_SECONDS = 10
const STATEMENT_TIMEOUT_MS = 10_000

// 选项和服务的连接池同一个来源（postgresOptions），只多了这次检查用的时限与单条连接。
// 不发额外的启动参数：经 PgBouncer 时它会拒绝不认识的启动参数，检查过了服务却连不上。
// 语句的时限在事务里用 set local 设（见 probeDatabase），不留在连接上
function open(url: string): postgres.Sql {
  return postgres(
    url,
    postgresOptions({ max: 1, connect_timeout: CONNECT_TIMEOUT_SECONDS, idle_timeout: 1 }),
  )
}

// 按表单拼连接串。主机已按契约只收主机名与地址，IPv6 地址加方括号；其余各段按 URL 编码，
// postgres.js 解析时逐段解码
export function connectionUrl(c: DatabaseConnection): string {
  const host = c.host.includes(':') ? `[${c.host}]` : c.host
  const enc = encodeURIComponent
  return `postgres://${enc(c.username)}:${enc(c.password)}@${host}:${c.port}/${enc(c.database)}?sslmode=${c.ssl}`
}

// 给人看的连接信息，按 postgres.js 自己的解析取（不连库）；解析不了时为 null
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

// 连接失败的类别：数据库报的 SQLSTATE、驱动与系统的错误 code
export function failureOf(err: unknown): DatabaseFailure {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string') return 'unknown'
  if (UNREACHABLE.has(code)) return 'unreachable'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'host_not_found'
  if (code === 'CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === '57014') return 'timeout'
  if (code === '28P01' || code.startsWith('SASL_') || code === 'AUTH_TYPE_NOT_IMPLEMENTED') {
    return 'auth_failed'
  }
  // 28000：pg_hba.conf 里没有放行这个地址、用户与库的组合
  if (code === '28000') return 'not_allowed'
  if (code === '3D000') return 'database_missing'
  if (code === '42501') return 'permission_denied'
  if (code === 'SSL_NOT_SUPPORTED') return 'ssl_unsupported'
  if (/^ERR_(TLS|SSL)_|CERT|SELF_SIGNED|UNABLE_TO_/.test(code)) return 'ssl_failed'
  // 53300：连接数满了；57P03：数据库正在启动或关闭
  if (code === '53300' || code === '57P03') return 'busy'
  // 57P01、57P02：数据库被关停或崩溃，连接被断开；08 类：连接异常
  if (code === '57P01' || code === '57P02' || code.startsWith('08')) return 'unreachable'
  return 'unknown'
}

// 不是连接问题的类别：权限不足（42501）与认不出的错误。这两类重试也不会好
const NOT_TRANSIENT = new Set<DatabaseFailure>(['permission_denied', 'unknown'])

// 错误是不是「连接出了问题」（断开、超时、连不上、认证失败、库不见了等，可能自己好），是的话给出类别。
// 依次看错误本身、drizzle 包着的驱动错误、驱动连接错误的 cause：驱动直接抛的连接错误不解开（见 db/client.ts）
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

// Kioku 自己的表（public 下）；别的 schema 里只有迁移记录（drizzle）与后台任务（pgboss）是它的
const OWN_TABLES = new Set(
  (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => getTableName(table)),
)

export interface DatabaseFacts {
  role: { name: string; superuser: boolean; bypassRls: boolean }
  extensions: { name: DatabaseExtension; state: ExtensionState }[]
  existing: ExistingData
  accounts: number | null
  unrelatedTables: number
}

// 哪些问题拦住接入，只在这里判断：角色绕过行级安全、缺扩展、库的结构这个版本用不了。
// 无关的表与已有账号只提醒，不算问题
export function problemsOf(facts: DatabaseFacts): DatabaseProblem[] {
  const problems: DatabaseProblem[] = []
  if (facts.role.superuser) problems.push({ code: 'superuser' })
  else if (facts.role.bypassRls) problems.push({ code: 'bypass_rls' })
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

// 连上了，读库的结构时出错：权限不足单独说明（例如角色对已有的表没有权限），别的只说读取失败。都不会自己好
function inspectFailedCheck(err: unknown): DatabaseCheck {
  const code = errorCode(pgErrorOf(err))
  return {
    ...failedCheck('unknown'),
    failure: null,
    problems: [{ code: code === '42501' ? 'insufficient_privilege' : 'inspect_failed' }],
  }
}

// 连不上之外的问题：角色、扩展、库的结构、权限。这些不会自己好，服务启动时遇到就拒绝启动
export function isFatal(check: DatabaseCheck): boolean {
  return check.problems.some((p) => p.code !== 'connection')
}

// 检查一个库能不能给 Kioku 用（只读，不改库）
export async function probeDatabase(url: string, migrationsFolder: string): Promise<DatabaseCheck> {
  const client = open(url)
  // 连上了没有：连上之后的语句错误（权限不足等）不是连接问题，不能报成连不上
  let connected = false
  try {
    // 只读的事务：语句时限用 set local，事务结束就失效，经连接池复用的连接上不留设置
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
  const [role] = await client<{ name: string; superuser: boolean; bypassRls: boolean }[]>`
    select rolname as name, rolsuper as superuser, rolbypassrls as "bypassRls"
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
  const existing: ExistingData =
    migrations === 'none' ? 'empty' : migrations === 'known' ? 'kioku' : migrations
  let accounts: number | null = null
  if (existing === 'kioku') {
    const [table] = await client<{ exists: boolean }[]>`
      select to_regclass('public.accounts') is not null as exists`
    if (table?.exists) {
      const [row] = await client<{ n: number }[]>`select count(*)::int as n from public.accounts`
      accounts = row?.n ?? 0
    }
  }
  // 普通的表、视图与分区表的父表；扩展自己建的（zhparser 的自定义词表）不算
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
  return { role, extensions, existing, accounts, unrelatedTables }
}

const EXTENSION_MISSING_CODES = new Set(['0A000', '58P01'])

// 超级用户代建失败
export class ProvisionError extends Error {
  constructor(
    readonly problem: ProvisionProblem,
    readonly detail: { failure?: DatabaseFailure; extensions?: DatabaseExtension[] } = {},
  ) {
    super(problem)
  }
}

// 预先算好的 SCRAM-SHA-256 口令：建角色的语句里不出现明文密码，数据库开着语句日志时也不会记下它
export function scramVerifier(password: string): string {
  const salt = randomBytes(16)
  const iterations = 4096
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const clientKey = createHmac('sha256', salted).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest()
  const serverKey = createHmac('sha256', salted).update('Server Key').digest()
  const b64 = (b: Buffer) => b.toString('base64')
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`
}

export interface Provisioned {
  // 应用角色的连接串（随机密码）
  url: string
  // 接入失败时删掉建出来的库与角色
  undo: () => Promise<void>
}

// 用超级用户建应用角色与库、在新库里装扩展，和 docker/postgres/init/10-kioku.sh 的做法一样。
// 角色不是超级用户、没有 BYPASSRLS，也不能建库建角色；密码随机生成，只出现在返回的连接串里。
// 超级用户的密码只在这次调用里用，不保存、不进日志。中途失败时删掉已经建出来的
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

    // 名字已按契约只收小写的普通标识符，口令是 base64 与 $ :，都不用转义
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
      // 只有扩展本身装不上才说缺扩展：0A000（不支持）、58P01（控制文件或库文件不在）。
      // 连不上新库、权限不够这类按连接的类别报
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
