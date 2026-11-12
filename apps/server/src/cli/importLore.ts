import { parseArgs } from 'node:util'

import {
  LAYER_NAMES,
  LORE_DEFAULT_PERSONA,
  SENSITIVITY_NAMES,
  Slug,
  type LoreSyncChange,
  type LoreTargetState,
  type LoreWarningKind,
} from '@kioku/contracts'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'

import { loadConfig } from '../config'
import { assertRuntimeRole, connect, type Db } from '../db/client'
import { pendingMigrations } from '../db/migrate'
import { accounts, spaceMembers } from '../db/schema'
import {
  applyImport,
  applySync,
  assertExecutable,
  existingImportApps,
  inPlanSnapshot,
  loreTitle,
  MAX_DISCLOSURE,
  plainSensitivity,
  planImportFor,
  planSync,
  previewImport,
  readLore,
  requestLayer,
  verifyMasterKey,
  type ImportPlan,
  type ImportPreview,
  type ImportResult,
  type SyncItem,
  type SyncPlan,
  type SyncResult,
  type SyncState,
  type TargetPreview,
} from '../importer/lore'
import { requestBackfill } from '../jobs/queue'
import { MemoryError } from '../memory/service'
import { DATABASE_ENV_HELP, databaseUrlOf, runCli, UsageError } from './common'

const HELP = `从 Lore 导入记忆。

用法：node dist/import-lore.mjs --account <用户名> [选项]

默认只打印导入计划，确认无误后加 --apply 执行。可以重复执行：按 Lore 节点去重，导入过的节点不再写入
（导入后在 Kioku 里删除或移动了的也不会写回）；目标坐标（URI）已被其他记忆占用的，计划里列为不导入。
加 --sync 时，导入过的节点也按 Lore 现在的内容更新，但只更新导入（或上次同步）之后
在 Kioku 里没人改过的；改过、移动过、删除了的，以及 Lore 里换了路径的，都只列出来。

Lore 的 URI 映射到这些坐标（括号里是归属，下级路径照搬）。标题取正文第一个 # 标题，没有就用标识
（坐标的最后一段），机密的只用标识：
  core://soul            → persona://<人格>/soul（人格）
  core://agent/<运行时>  → app://<应用>/agent（导入者自己的对应应用）
  core:// 下别的         → 坐标不变（通用）
  preferences://<路径>   → user://preferences/<路径>（导入者本人 · 内部）
  别的，如 infra://nas   → user://infra/nas（导入者本人 · 私密）

  --account <用户名>      导入到这个账号名下，需要是空间所有者
  --space <空间 id>       账号属于多个空间时指定
  --persona <标识>        core://soul 导入为这个人格的设定，默认 default；要写入新的 core://soul 时不存在就新建
  --persona-name <名称>   新建人格时用的名称，默认「默认人格」
  --secret <Lore 的 URI>  把这个节点导入为机密（正文加密存储），可以重复；对已导入的节点不生效
  --sync                  同步导入过的节点：正文、标题、优先级、触发场景与关键词改成 Lore 里现在的
  -v, --verbose           已导入的、同步时已是最新的也逐条列出（默认只给条数）
  --apply                 执行导入（与同步）；不加时只打印计划

环境变量：
${DATABASE_ENV_HELP}
  LORE_DATABASE_URL          Lore 的数据库，只读访问
  KIOKU_MASTER_KEY           导入或同步机密记忆时需要，与服务相同`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: 'string' },
      space: { type: 'string' },
      persona: { type: 'string', default: LORE_DEFAULT_PERSONA.slug },
      'persona-name': { type: 'string', default: LORE_DEFAULT_PERSONA.name },
      secret: { type: 'string', multiple: true, default: [] },
      sync: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
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
  const database = connect(databaseUrlOf(config), { max: 2 })
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

    const target = { db: database.db, spaceId, accountId, masterKey: config.masterKey }
    const lore = postgres(loreUrl, { max: 1, onnotice: () => {} })
    const snapshot = await readLore(lore).finally(() => lore.end())
    // 和管理界面同一份计划：坐标已被别的记忆占用的目标在计划里就列为不导入；计划、预览与同步在同一个快照里读。
    // 先打印计划，再核对主密钥：主密钥不对时不加 --apply 的预演也看得到计划和 --secret 的错误
    const { plan, preview, sync } = await inPlanSnapshot(target, async (snap) => {
      const base = await planImportFor(snap, snapshot, await existingImportApps(snap.db, spaceId), {
        accountId,
        persona: { slug: values.persona, name: values['persona-name'] },
        secretUris: new Set(values.secret),
        quoteMalformed: true,
      })
      const versions = snapshot.nodes.reduce((n, node) => n + node.previousVersions, 0)
      console.log(
        `Lore：${snapshot.nodes.length} 个节点；${versions} 个旧版本不迁移` +
          (snapshot.recallEvents === null ? '' : `；${snapshot.recallEvents} 条召回事件不迁移`),
      )
      const preview = await previewImport(snap, base.plan, base.imports)
      printPlan(base.plan, preview, values.verbose)
      // 计划有错误时下面直接退出，不用同步
      if (!values.sync || base.plan.errors.length) return { plan: base.plan, preview, sync: null }
      // 同步要读出机密记忆来比对：先确认主密钥和服务用的是同一把，免得解密失败时才发现。
      // 用连接池另开连接核对：它并行读几项设置，快照里只能一步一步地读
      if (config.masterKey) await verifyMasterKey(database.db, spaceId, config.masterKey)
      const sync = await planSync(snap, base.plan, snapshot, base.imports)
      return { plan: base.plan, preview, sync }
    })
    if (plan.errors.length) {
      // 命令行只有 --secret 会对不上
      const lines = plan.errors.map((e) => `  --secret 指定的 ${e.uri} 在 Lore 里不存在`)
      console.error(`\n计划有错误，不能执行：\n${lines.join('\n')}`)
      process.exitCode = 2
      return
    }
    if (sync) printSync(sync, values.verbose)
    if (!values.apply) {
      const created = preview.targets.filter((t) => t.state === 'new').length
      const updated = sync ? `、按 Lore 更新 ${syncOf(sync, 'update').length} 条` : ''
      console.log(
        `\n以上是计划，没有写入任何数据。确认无误后加 --apply 执行：新建 ${created} 条${updated}。`,
      )
      return
    }
    // 有机密节点时，写入任何东西之前先确认主密钥可用、且和服务用的是同一把。
    // 计划的错误上面已经报过，这里只会是缺主密钥
    try {
      assertExecutable(plan, config.masterKey)
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err
      throw new UsageError('要导入机密节点，需要设置与服务相同的 KIOKU_MASTER_KEY')
    }
    if (config.masterKey && plan.memories.some((m) => m.request.sensitivity === 'secret')) {
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
      await requestBackfill(databaseUrlOf(config)).catch((err: unknown) =>
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
  // 导入要写机密记忆、新建人格和应用，需要空间所有者的权限
  if (membership.role !== 'owner') throw new UsageError(`${username} 不是空间所有者`)
  return { spaceId: membership.spaceId, accountId: account.id }
}

const WARNINGS: Record<LoreWarningKind, (uri: string) => string> = {
  credentialPath: (uri) => `${uri} 的路径疑似凭据，未用 --secret 标记`,
  credentialContent: (uri) => `${uri} 的正文疑似含密码或令牌，未用 --secret 标记`,
  credentialExtras: (uri) => `${uri} 的触发场景或关键词疑似含密码或令牌，未用 --secret 标记`,
  secretExtras: (uri) => `${uri} 的触发场景或关键词疑似含凭据：机密只加密正文，这两项仍为明文`,
  disclosureTruncated: (uri) => `${uri} 的触发场景超过 ${MAX_DISCLOSURE} 字，已截断`,
}

// 几种状态的条数写成一句：always 的是 0 也写，别的是 0 就不写；note 接在条数后面
function counts(parts: [label: string, count: number, always?: boolean, note?: string][]): string {
  return parts
    .filter(([, count, always]) => always || count > 0)
    .map(([label, count, , note]) => `${label} ${count} 条${note ?? ''}`)
    .join('，')
}

// 只给条数、不逐条列出的那一组，提示怎么列出来
const VERBOSE_NOTE = '（--verbose 逐条列出）'

// 一组逐条列出的：标题里带条数，没有的整组不出现
function list(heading: string, lines: string[]): void {
  if (!lines.length) return
  console.log(`\n${heading}：`)
  for (const line of lines) console.log(`  ${line}`)
}

function personaLine(plan: ImportPlan, preview: ImportPreview): string {
  const { slug, name } = plan.persona
  if (!preview.personaExists && !preview.createsPersona) {
    return `这次没有要写入的 core://soul，人格 ${slug} 也不存在：不新建，新建的应用默认人格为空`
  }
  return plan.memories.some((m) => requestLayer(m.request) === 'persona')
    ? `core://soul 导入为 ${slug}（不存在时新建为「${name}」）`
    : `这次没有要导入的 core://soul，不新建人格；已有的人格 ${slug} 照常用，新建的应用和还没有默认人格的应用设成它`
}

// 一个写入目标：标题、坐标（和 Lore 的 URI 不同时带上来源）、归属 · 敏感级 · 优先级。
// 新建的按这次的计划，--secret 标的写机密；已导入的按记忆现在的样子：之前导入的那条已经是机密的写机密，
// 还是明文的 --secret 也改不了（见提醒）。标题和写入时同一个取法，机密的只用标识
function targetLine({ item, state, current }: TargetPreview): string {
  const uri = item.request.uri
  const layer = requestLayer(item.request)
  const secret =
    state === 'new' ? item.request.sensitivity === 'secret' : current.some((c) => c.secret)
  const sensitivity = secret ? 'secret' : plainSensitivity(item.source, layer)
  const from = item.source === uri ? '' : ` ← ${item.source}`
  return (
    `${loreTitle(item.request.content, uri, secret)}  ${uri}${from}  ` +
    `${LAYER_NAMES[layer]} · ${SENSITIVITY_NAMES[sensitivity]} · P${item.request.priority}`
  )
}

// 之前导入的那些记忆现在在哪：移动过、删除了的说一声，还在原处的不说
function currentNote({ item, current }: TargetPreview): string {
  const notes = current.flatMap((c) =>
    c.uri === null ? ['已在 Kioku 里删除'] : c.uri === item.request.uri ? [] : [`现在在 ${c.uri}`],
  )
  return notes.length ? `（之前导入的${notes.join('；')}）` : ''
}

function printPlan(plan: ImportPlan, preview: ImportPreview, verbose: boolean): void {
  console.log(`\n人格：${personaLine(plan, preview)}`)
  if (plan.apps.length) {
    console.log('\n应用：')
    for (const mapping of plan.apps) {
      const targets = mapping.apps.map((a) =>
        a.create ? `${a.slug}（新建，类型 ${a.runtimeFamily}）` : `${a.slug}（已有）`,
      )
      console.log(`  ${mapping.runtime} → ${targets.join('、')}`)
    }
  }

  // 先给各状态的条数，再按状态分组列出。已导入的不再写入，默认只给条数
  const of = (state: LoreTargetState) => preview.targets.filter((t) => t.state === state)
  const created = of('new')
  const imported = of('imported')
  const moved = of('moved')
  console.log(
    `\n计划：${counts([
      ['新建', created.length, true],
      ['已导入', imported.length, true, verbose || !imported.length ? '' : VERBOSE_NOTE],
      ['Lore 里换了路径', moved.length],
      ['不导入', plan.skipped.length],
    ])}`,
  )
  list(`新建（${created.length} 条）`, created.map(targetLine))
  if (verbose) {
    list(
      `已导入（${imported.length} 条），不再写入`,
      imported.map((t) => `${targetLine(t)}${currentNote(t)}`),
    )
  }
  list(
    `Lore 里换了路径（${moved.length} 条），不在新位置新建；之前导入的留在原处，要跟着移动就在管理界面移`,
    moved.map((t) => `${targetLine(t)}${currentNote(t)}`),
  )
  list(
    `不导入（${plan.skipped.length} 条）`,
    plan.skipped.map((s) => `${s.source}：${s.reason}`),
  )
  list(
    `丢弃的关键词（${plan.droppedKeywords.length} 个）`,
    plan.droppedKeywords.map((k) => `${k.source}「${k.keyword}」：${k.reason}`),
  )
  // --secret 只对要新建的目标起作用：导入过、现在还是明文的写入时照样跳过，在这里先说
  const secretIgnored = preview.targets.flatMap(({ item, state, current }) =>
    state !== 'new' && item.request.sensitivity === 'secret'
      ? current
          .filter((c) => c.uri !== null && !c.secret)
          .map(
            (c) =>
              `${item.source} 之前导入过，现在是明文，--secret 对它不生效：请在管理界面把 ${c.uri} 改为机密`,
          )
      : [],
  )
  const warnings = [...plan.warnings.map((w) => WARNINGS[w.kind](w.uri)), ...secretIgnored]
  list(`提醒（${warnings.length} 条）`, warnings)
}

function printResult(plan: ImportPlan, result: ImportResult): void {
  console.log('\n导入完成：')
  console.log(
    result.personaUsed
      ? `  人格 ${plan.persona.slug}：${result.personaCreated ? '新建' : '已有'}`
      : `  人格 ${plan.persona.slug} 不存在，这次也没有要写入的 core://soul：没有新建，新建的应用默认人格为空`,
  )
  if (result.appsCreated.length) console.log(`  新建应用：${result.appsCreated.join('、')}`)
  if (result.appsGivenPersona.length) {
    console.log(`  设为默认人格 ${plan.persona.slug}：${result.appsGivenPersona.join('、')}`)
  }
  if (result.appsOtherPersona.length) {
    console.log(
      `  这些应用在用别的人格，core://soul 不会进入它们的启动加载：${result.appsOtherPersona.join('、')}`,
    )
  }
  console.log(
    `  新建 ${result.created.length} 条；已导入、跳过 ${result.previouslyImported.length} 条` +
      `（包括导入后在 Kioku 里删除或移动了的）`,
  )
  for (const uri of result.occupied) console.log(`  跳过 ${uri}：坐标已被其他记忆占用`)
  for (const { uri, current } of result.movedInLore) {
    console.log(
      current
        ? `  跳过 ${uri}：Lore 里换了路径，之前导入的那条还在 ${current}，没有在新位置再建一条（要跟着移动就在管理界面移）`
        : `  跳过 ${uri}：Lore 里换了路径，之前导入的那条在 Kioku 里删除了，没有在新位置再建一条`,
    )
  }
  for (const { uri, current } of result.secretAlreadyImported) {
    const moved = current === uri ? '' : `（导入后移到了 ${current}）`
    console.log(
      `  注意 ${uri}${moved}：之前导入过，现在还是明文，这次的 --secret 没有生效。请在管理界面把 ${current} 改为机密（会同时清除历史里的明文）`,
    )
  }
  for (const f of result.failed) console.log(`  失败 ${f.uri}：${f.reason}`)
  if (result.appsCreated.length) {
    console.log('  新建的应用暂无访问密钥：在管理界面的「应用」页为要接入的应用签发')
  }
}

const CHANGE_LABELS: Record<LoreSyncChange, string> = {
  content: '正文',
  title: '标题',
  priority: '优先级',
  disclosure: '触发场景',
  glossary: '关键词',
}

const syncOf = (sync: SyncPlan, state: SyncState) => sync.items.filter((i) => i.state === state)

// 同步项：标题、记忆现在的坐标，再加上各状态要说的（要更新的几项、换了路径之后应在的坐标、原因）
function syncLine(item: SyncItem): string {
  const head = `${item.title}  ${item.uri}`
  switch (item.state) {
    case 'update':
      return `${head}：${item.changes.map((c) => CHANGE_LABELS[c]).join('、')}`
    case 'moved':
      return `${head} → ${item.target}`
    case 'skipped':
    case 'unreadable':
      return `${head}：${item.reason}`
    default:
      return head
  }
}

// 不同步的几种：条数里的叫法，与逐条列出时的标题
const NOT_SYNCED: [SyncState, string, (n: number) => string][] = [
  [
    'edited',
    '在 Kioku 里改过',
    (n) => `导入后在 Kioku 里改过或移动过（${n} 条），不同步；要跟上 Lore 就在管理界面手动改`,
  ],
  [
    'moved',
    'Lore 里换了路径',
    (n) =>
      `Lore 里换了路径（${n} 条），不同步；移动可能改变归属与可见范围，要在管理界面手动移动，移动之后只能手动更新`,
  ],
  ['deleted', '在 Kioku 里删除了', (n) => `在 Kioku 里删除了（${n} 条），不同步`],
  [
    'skipped',
    '这次不导入',
    (n) => `这次的导入计划不导入（${n} 条），没有同步；原因见上面的「不导入」`,
  ],
  [
    'unmapped',
    '没有映射到',
    (n) => `这次的计划没有映射到（${n} 条），没有同步；例如换了 --persona，或者对应的应用不在了`,
  ],
  ['unreadable', '读不出来', (n) => `读不出来（${n} 条），没有同步`],
]

// 同步也是先给条数再分组列出：已是最新的默认只给条数
function printSync(sync: SyncPlan, verbose: boolean): void {
  const current = syncOf(sync, 'current')
  const update = syncOf(sync, 'update')
  const gone = sync.goneFromLore
  console.log(
    `\n同步导入过的节点：${counts([
      ['按 Lore 更新', update.length, true],
      ['已是最新', current.length, true, verbose || !current.length ? '' : VERBOSE_NOTE],
      ...NOT_SYNCED.map(([state, label]): [string, number] => [label, syncOf(sync, state).length]),
      ['Lore 里已经没有', gone.length],
    ])}`,
  )
  list(`按 Lore 更新（${update.length} 条）`, update.map(syncLine))
  if (verbose) list(`已是最新（${current.length} 条）`, current.map(syncLine))
  for (const [state, , heading] of NOT_SYNCED) {
    const items = syncOf(sync, state)
    list(heading(items.length), items.map(syncLine))
  }
  list(`Lore 里已经没有这个节点（${gone.length} 条），Kioku 里保留；要删就在管理界面删`, gone)
}

function printSyncResult(result: SyncResult): void {
  console.log(`\n同步完成：更新 ${result.updated.length} 条`)
  for (const f of result.failed) console.log(`  失败 ${f.uri}：${f.reason}`)
}

runCli(HELP, main)
