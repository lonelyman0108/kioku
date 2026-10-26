import { parseArgs } from 'node:util'

import { Slug } from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'

import { loadConfig } from '../config'
import { assertRuntimeRole, connect, withSpace, type Db } from '../db/client'
import { pendingMigrations } from '../db/migrate'
import { accounts, apps, spaceMembers } from '../db/schema'
import {
  applyImport,
  planImport,
  readLore,
  verifyMasterKey,
  type ImportPlan,
  type ImportResult,
} from '../importer/lore'
import { requestBackfill } from '../jobs/queue'
import { DEFAULT_SENSITIVITY } from '../memory/uri'

const HELP = `从 Lore 导入记忆。

用法：node dist/import-lore.mjs --account <用户名> [选项]

默认只打印导入计划，确认无误后加 --apply 执行。可以重复执行：按 Lore 节点去重，
导入过的节点不再写入（导入后在 Kioku 里删除或移动了的也不会写回），URI 被别的记忆占用时跳过。

  --account <用户名>     导入到这个账号名下，需要是空间 owner。preferences:// 进它的主人层，
                         core:// 以外的其余 domain 进它的私人层
  --space <空间 id>      账号属于多个空间时指定
  --persona <标识>       core://soul 导入成这个人格的设定，默认 default，不存在时新建
  --persona-name <名称>  新建人格时用的名称，默认「默认人格」
  --secret <Lore URI>    把这条记忆导入为 secret（加密存储），可以重复
  --apply               执行导入；不加时只打印计划

环境变量：
  DATABASE_URL       Kioku 的数据库，与服务相同
  LORE_DATABASE_URL  Lore 的数据库，只读访问
  KIOKU_MASTER_KEY   导入 secret 时需要，与服务相同`

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      space: { type: 'string' },
      persona: { type: 'string', default: 'default' },
      'persona-name': { type: 'string', default: '默认人格' },
      secret: { type: 'string', multiple: true, default: [] },
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (!values.account) throw new UsageError('缺少 --account')
  if (!Slug.safeParse(values.persona).success) {
    throw new UsageError('--persona 只用小写字母、数字和连字符')
  }
  const loreUrl = process.env.LORE_DATABASE_URL
  if (!loreUrl) throw new UsageError('缺少环境变量 LORE_DATABASE_URL')

  const config = loadConfig()
  const database = connect(config.databaseUrl, { max: 2 })
  try {
    await assertRuntimeRole(database.db)
    if ((await pendingMigrations(database.db, config.migrationsFolder)) !== 0) {
      throw new Error('Kioku 数据库的迁移与这个版本不一致：先用同一版本启动一次服务完成迁移')
    }
    const { spaceId, accountId } = await resolveTarget(
      database.db,
      values.account,
      values.space ?? null,
    )

    const lore = postgres(loreUrl, { max: 1, onnotice: () => {} })
    const snapshot = await readLore(lore).finally(() => lore.end())
    const existingApps = await withSpace(database.db, spaceId, (tx) =>
      tx
        .select({
          slug: apps.slug,
          runtimeFamily: apps.runtimeFamily,
          ownerAccountId: apps.ownerAccountId,
        })
        .from(apps),
    )
    const plan = planImport(snapshot, existingApps, {
      accountId,
      persona: { slug: values.persona, name: values['persona-name'] },
      secretUris: new Set(values.secret),
    })

    const versions = snapshot.nodes.reduce((n, node) => n + node.previousVersions, 0)
    console.log(
      `Lore：${snapshot.nodes.length} 个节点；${versions} 个旧版本不迁移` +
        (snapshot.recallEvents === null ? '' : `；${snapshot.recallEvents} 条召回事件不迁移`),
    )
    printPlan(plan)
    if (plan.errors.length) {
      console.error(`\n计划有错误，不能执行：\n${plan.errors.map((e) => `  ${e}`).join('\n')}`)
      process.exitCode = 2
      return
    }
    if (!values.apply) {
      console.log('\n以上是导入计划，没有写入任何数据。确认无误后加 --apply 执行。')
      return
    }
    // 有 secret 时，写入任何东西之前先确认主密钥可用、且和服务用的是同一把
    if (plan.memories.some((m) => m.request.sensitivity === 'secret')) {
      if (!config.masterKey)
        throw new UsageError('要导入 secret，需要设置与服务相同的 KIOKU_MASTER_KEY')
      if (!(await verifyMasterKey(database.db, spaceId, config.masterKey))) {
        console.warn('库里还没有加密过的数据，无法确认 KIOKU_MASTER_KEY 与服务一致，请自行核对')
      }
    }

    const result = await applyImport(
      { db: database.db, spaceId, accountId, masterKey: config.masterKey },
      plan,
    )
    printResult(plan, result)
    if (result.created.length) {
      // 向量由服务的后台任务生成；服务没在运行时，下次启动也会补齐
      await requestBackfill(config.databaseUrl).catch((err: unknown) =>
        console.warn('没能安排向量补齐，服务下次启动时会补上', err),
      )
    }
    if (result.failed.length || result.secretAlreadyImported.length) process.exitCode = 1
  } finally {
    await database.close()
  }
}

async function resolveTarget(
  db: Db,
  username: string,
  space: string | null,
): Promise<{ spaceId: string; accountId: string }> {
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.username, username))
  if (!account) throw new UsageError(`账号不存在：${username}`)
  const memberships = await db
    .select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role })
    .from(spaceMembers)
    .where(
      space
        ? and(eq(spaceMembers.accountId, account.id), eq(spaceMembers.spaceId, space))
        : eq(spaceMembers.accountId, account.id),
    )
  if (!memberships.length)
    throw new UsageError(`${username} 不是${space ? '该' : '任何'}空间的成员`)
  if (memberships.length > 1) throw new UsageError(`${username} 属于多个空间，用 --space 指定`)
  const membership = memberships[0]!
  // 导入要写 secret、新建人格和应用，需要空间 owner 的权限
  if (membership.role !== 'owner') throw new UsageError(`${username} 不是空间 owner`)
  return { spaceId: membership.spaceId, accountId: account.id }
}

function printPlan(plan: ImportPlan): void {
  console.log(
    `\n人格：core://soul 导入为 ${plan.persona.slug}（不存在时新建为「${plan.persona.name}」）`,
  )
  if (plan.apps.length) {
    console.log('\n应用：')
    for (const mapping of plan.apps) {
      const targets = mapping.apps.map((a) =>
        a.create ? `${a.slug}（新建，类型 ${a.runtimeFamily}）` : `${a.slug}（已有）`,
      )
      console.log(`  ${mapping.runtime} → ${targets.join('、')}`)
    }
  }
  console.log(`\n记忆（${plan.memories.length} 条）：`)
  for (const m of plan.memories) {
    const layer = m.request.layer!
    const sensitivity = m.request.sensitivity ?? DEFAULT_SENSITIVITY[layer]
    const target = m.request.uri === m.source ? '' : ` → ${m.request.uri}`
    console.log(`  ${m.source}${target}  [${layer} · ${sensitivity} · p${m.request.priority}]`)
  }
  if (plan.skipped.length) {
    console.log('\n不导入：')
    for (const s of plan.skipped) console.log(`  ${s.source}：${s.reason}`)
  }
  if (plan.droppedKeywords.length) {
    console.log('\n丢弃的关键词：')
    for (const k of plan.droppedKeywords) console.log(`  ${k.source}「${k.keyword}」：${k.reason}`)
  }
  if (plan.warnings.length) {
    console.log('\n提醒：')
    for (const w of plan.warnings) console.log(`  ${w}`)
  }
}

function printResult(plan: ImportPlan, result: ImportResult): void {
  console.log('\n导入完成：')
  console.log(`  人格 ${plan.persona.slug}：${result.personaCreated ? '新建' : '已有'}`)
  if (result.appsCreated.length) console.log(`  新建应用：${result.appsCreated.join('、')}`)
  if (result.appsGivenPersona.length) {
    console.log(`  设为默认人格 ${plan.persona.slug}：${result.appsGivenPersona.join('、')}`)
  }
  if (result.appsOtherPersona.length) {
    console.log(
      `  这些应用在用别的人格，core://soul 不会进入它们的启动上下文：${result.appsOtherPersona.join('、')}`,
    )
  }
  console.log(
    `  新建记忆 ${result.created.length} 条；之前导入过、跳过 ${result.previouslyImported.length} 条` +
      `（包括导入后在 Kioku 里删除或移动了的）`,
  )
  for (const uri of result.occupied) console.log(`  跳过 ${uri}：URI 已被别的记忆占用`)
  for (const uri of result.secretAlreadyImported) {
    console.log(
      `  注意 ${uri}：之前导入过，现在还是明文，这次的 --secret 没有生效。请在管理界面把它改成 secret（会同时清除历史里的明文）`,
    )
  }
  for (const f of result.failed) console.log(`  失败 ${f.uri}：${f.reason}`)
  if (result.appsCreated.length) {
    console.log('  新建的应用还没有 Key：在管理界面「应用与 Key」里为要接入的应用签发')
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
