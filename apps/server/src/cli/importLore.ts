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
  applySync,
  planImport,
  planSync,
  readLore,
  verifyMasterKey,
  type ImportPlan,
  type ImportResult,
  type SyncPlan,
  type SyncResult,
} from '../importer/lore'
import { requestBackfill } from '../jobs/queue'
import { DEFAULT_SENSITIVITY } from '../memory/uri'

const HELP = `从 Lore 导入记忆。

用法：node dist/import-lore.mjs --account <用户名> [选项]

默认只打印导入计划，确认无误后加 --apply 执行。可以重复执行：按 Lore 节点去重，
导入过的节点不再写入（导入后在 Kioku 里删除或移动了的也不会写回），URI 被别的记忆占用时跳过。
加 --sync 时，导入过的节点也按 Lore 现在的内容更新，但只更新导入（或上次同步）之后
在 Kioku 里没人改过的；改过、移动过、删除了的，以及 Lore 里换了路径的，都只列出来。

  --account <用户名>     导入到这个账号名下，需要是空间 owner。preferences:// 进它的主人层，
                         core:// 以外的其余 domain 进它的私人层
  --space <空间 id>      账号属于多个空间时指定
  --persona <标识>       core://soul 导入成这个人格的设定，默认 default，不存在时新建
  --persona-name <名称>  新建人格时用的名称，默认「默认人格」
  --secret <Lore URI>    把这条记忆导入为 secret（加密存储），可以重复
  --sync                同步导入过的节点：正文、priority、disclosure 与关键词改成 Lore 里现在的
  --apply               执行导入（与同步）；不加时只打印计划

环境变量：
  DATABASE_URL       Kioku 的数据库，与服务相同
  LORE_DATABASE_URL  Lore 的数据库，只读访问
  KIOKU_MASTER_KEY   导入或同步 secret 时需要，与服务相同`

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      space: { type: 'string' },
      persona: { type: 'string', default: 'default' },
      'persona-name': { type: 'string', default: '默认人格' },
      secret: { type: 'string', multiple: true, default: [] },
      sync: { type: 'boolean', default: false },
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
    const target = { db: database.db, spaceId, accountId, masterKey: config.masterKey }
    // 同步要读出 secret 记忆来比对：先确认主密钥和服务用的是同一把，免得解密失败时才发现
    if (values.sync && config.masterKey)
      await verifyMasterKey(database.db, spaceId, config.masterKey)
    const sync = values.sync ? await planSync(target, plan, snapshot) : null
    if (sync) printSync(sync)
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

    const result = await applyImport(target, plan)
    printResult(plan, result)
    const synced = sync ? await applySync(target, sync) : null
    if (synced) printSyncResult(synced)
    if (result.created.length || synced?.updated.length) {
      // 向量由服务的后台任务生成；服务没在运行时，下次启动也会补齐
      await requestBackfill(config.databaseUrl).catch((err: unknown) =>
        console.warn('没能安排向量补齐，服务下次启动时会补上', err),
      )
    }
    if (result.failed.length || result.secretAlreadyImported.length || synced?.failed.length) {
      process.exitCode = 1
    }
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
  for (const { uri, current } of result.secretAlreadyImported) {
    const moved = current === uri ? '' : `（导入后移到了 ${current}）`
    console.log(
      `  注意 ${uri}${moved}：之前导入过，现在还是明文，这次的 --secret 没有生效。请在管理界面把 ${current} 改成 secret（会同时清除历史里的明文）`,
    )
  }
  for (const f of result.failed) console.log(`  失败 ${f.uri}：${f.reason}`)
  if (result.appsCreated.length) {
    console.log('  新建的应用还没有 Key：在管理界面「应用与 Key」里为要接入的应用签发')
  }
}

const CHANGE_LABELS = {
  content: '正文',
  priority: 'priority',
  disclosure: 'disclosure',
  glossary: '关键词',
}

function printSync(sync: SyncPlan): void {
  const of = (state: string) => sync.items.filter((i) => i.state === state)
  console.log('\n同步导入过的节点：')
  const updates = of('update')
  console.log(`  按 Lore 更新 ${updates.length} 条，已是最新 ${of('current').length} 条`)
  for (const i of updates) {
    console.log(`    ${i.uri}：${i.changes.map((c) => CHANGE_LABELS[c]).join('、')}`)
  }
  const list = (title: string, lines: string[]) => {
    if (!lines.length) return
    console.log(`  ${title}：`)
    for (const line of lines) console.log(`    ${line}`)
  }
  list(
    '导入后在 Kioku 里改过或移动过，不同步（要跟上 Lore 就在管理界面手动改）',
    of('edited').map((i) => i.uri),
  )
  list(
    'Lore 里换了路径，不同步：移动可能改变层与可见范围，要在管理界面手动移动（移动之后这条就只能手动更新）',
    of('moved').map((i) => `${i.uri} → ${i.target}`),
  )
  list(
    '在 Kioku 里删除了，不同步',
    of('deleted').map((i) => i.uri),
  )
  list('Lore 里已经没有这个节点，Kioku 里保留（要删就在管理界面删）', sync.goneFromLore)
}

function printSyncResult(result: SyncResult): void {
  console.log(`\n同步完成：更新 ${result.updated.length} 条`)
  for (const f of result.failed) console.log(`  失败 ${f.uri}：${f.reason}`)
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
