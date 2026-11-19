import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import {
  LORE_DEFAULT_PERSONA,
  SENSITIVITY_NAMES,
  Slug,
  type LoreSyncChange,
  type LoreTargetState,
  type LoreWarningKind,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

import { loadConfig } from '../../config'
import { assertRuntimeRole, connect, type Db } from '../../db/client'
import { pendingMigrations } from '../../db/migrate'
import { accounts, circleMembers, circles } from '../../db/schema'
import {
  applyImport,
  applySync,
  assertExecutable,
  existingImportClientsIn,
  inPlanSnapshot,
  loreDataTimeIn,
  loreTitle,
  MAX_DISCLOSURE,
  planImportFor,
  planSync,
  previewImport,
  readLore,
  resolveCirclesForImport,
  staleAgainst,
  verifyMasterKey,
  type ImportPlan,
  type ImportPreview,
  type ImportResult,
  type LoreSnapshot,
  type SyncItem,
  type SyncPlan,
  type SyncResult,
  type SyncState,
  type TargetPreview,
} from '../../importer/lore'
import { parseLoreBackup } from '../../importer/loreBackup'
import { requestBackfill } from '../../jobs/queue'
import { MemoryError } from '../../memory/errors'
import { DATABASE_ENV_HELP, databaseUrlOf, runCli, UsageError } from '../common'
import { bold, dim, green, red, yellow } from '../format'

export const IMPORT_LORE_HELP = `从 Lore 导入记忆。

用法：kioku-ctl import-lore --account <用户名> [选项]
      node dist/import-lore.mjs --account <用户名> [选项]

默认只打印导入计划，确认无误后加 --apply 执行。可以重复执行：按 Lore 节点去重，导入过的节点不再写入
（导入后在 Kioku 里删除或移动了的也不会写回）；每次新建由服务端生成唯一短 ID，不再因目标路径撞车丢弃条目。
加 --sync 时，导入过的节点也按 Lore 现在的内容更新，但只更新导入（或上次同步）之后
在 Kioku 里没人改过的；改过、移动过、删除了的，以及 Lore 里换了路径的，都只列出来。

Lore 的 URI 映射到记忆圈、切面与独立人格（下级中间段转为主题标签），标题取正文第一个 # 标题，没有就用来源最后一段（机密的只用最后一段）：
  core://soul            → 目标记忆圈下指定人格（persona_traits）
  core://agent/<运行时>  → 目标记忆圈 · 带 runtime 切面的正式词条（并关联或新建接入实例）
  core:// 下别的         → 目标记忆圈 · 通用正式词条（内部）
  preferences://<路径>   → 导入者个人圈 · 正式词条（内部）
  别的，如 infra://nas   → 导入者个人圈 · 正式词条（私密）

  --account <用户名>      导入到这个账号名下，需要是目标记忆圈所有者
  --circle <标识或 id>    目标记忆圈（拥有多个共享圈时必传；不传时默认取唯一共享圈，否则个人圈）
  --file <JSON 文件>      从 Lore 导出的 JSON 文件读取（与直连数据库二选一）
  --from <数据库连接>     Lore 的 PostgreSQL 连接串（默认读 LORE_DATABASE_URL）
  --persona <标识>        core://soul 导入为这个人格的设定，默认 default；要写入新的 core://soul 时不存在就新建
  --persona-name <名称>   新建人格时用的名称，默认「默认人格」
  --secret <Lore 的 URI>  把这个节点导入为机密（正文加密存储），可以重复；对已导入的节点不生效
  --exclude <Lore URI>    本次不导入或不同步的节点，可以重复
  --sync                  同步导入过的节点：正文、标题、优先级、触发场景与关键词改成 Lore 里现在的
  --confirm-stale         使用导出文件且早于已导入数据时确认继续写入
  -v, --verbose           已导入的、同步时已是最新的也逐条列出（默认只给条数）
  --apply                 执行导入（与同步）；不加时只打印计划

环境变量：
${DATABASE_ENV_HELP}
  LORE_DATABASE_URL          Lore 的数据库，只读访问
  KIOKU_MASTER_KEY           导入或同步机密记忆时需要，与服务相同`

function parseImportLoreOptions(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        account: { type: 'string' },
        circle: { type: 'string' },
        space: { type: 'string' },
        file: { type: 'string' },
        from: { type: 'string' },
        persona: { type: 'string', default: LORE_DEFAULT_PERSONA.slug },
        'persona-name': { type: 'string', default: LORE_DEFAULT_PERSONA.name },
        secret: { type: 'string', multiple: true, default: [] },
        exclude: { type: 'string', multiple: true, default: [] },
        sync: { type: 'boolean', default: false },
        'confirm-stale': { type: 'boolean', default: false },
        verbose: { type: 'boolean', short: 'v', default: false },
        apply: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

async function loadLoreSnapshot(options: {
  file?: string | undefined
  from?: string | undefined
}): Promise<{ snapshot: LoreSnapshot; exportedAt?: string | undefined }> {
  if (options.file && options.from) {
    throw new UsageError('--file 与 --from 不能同时使用')
  }
  if (options.file) {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(options.file, 'utf8'))
    } catch {
      throw new UsageError(`无法读取或解析 Lore 导出文件：${options.file}`)
    }
    const parsed = parseLoreBackup(raw)
    return { snapshot: parsed.snapshot, exportedAt: parsed.exportedAt }
  }
  const loreUrl = options.from ?? process.env.LORE_DATABASE_URL
  if (!loreUrl) throw new UsageError('缺少 --file 或环境变量 LORE_DATABASE_URL（或 --from）')
  const lore = postgres(loreUrl, { max: 1, onnotice: () => {} })
  try {
    return { snapshot: await readLore(lore) }
  } finally {
    await lore.end()
  }
}

async function importLoreMain(argv: string[]): Promise<number> {
  const values = parseImportLoreOptions(argv)
  if (values.help) {
    console.log(IMPORT_LORE_HELP)
    return 0
  }
  if (!values.account) throw new UsageError('缺少 --account')
  if (!Slug.safeParse(values.persona).success) {
    throw new UsageError('--persona 只用小写字母、数字和连字符')
  }

  const circleArg = values.circle ?? values.space ?? null
  const loaded = await loadLoreSnapshot({ file: values.file, from: values.from })

  const config = loadConfig()
  const database = connect(databaseUrlOf(config), { max: 2 })
  try {
    await assertRuntimeRole(database.db)
    if ((await pendingMigrations(database.db, config.migrationsFolder)) !== 0) {
      throw new Error('Kioku 数据库的迁移与这个版本不一致：先用同一版本启动一次服务完成迁移')
    }

    const { circleId, accountId } = await resolveTarget(database.db, values.account, circleArg)
    const targetCircles = await resolveCirclesForImport(database.db, accountId, circleId)
    const target = {
      db: database.db,
      circleId: targetCircles.target.id,
      personalCircleId: targetCircles.personal.id,
      accountId,
      masterKey: config.masterKey,
    }

    const { plan, preview, sync, staleTime } = await inPlanSnapshot(target, async (snap) => {
      const existing = await existingImportClientsIn(snap.tx, targetCircles.target.id)
      const base = await planImportFor(snap, loaded.snapshot, targetCircles, existing, {
        accountId,
        persona: { slug: values.persona, name: values['persona-name'] },
        secretUris: new Set(values.secret),
        excludeUris: new Set(values.exclude),
        ...(loaded.exportedAt ? { exportedAt: loaded.exportedAt } : {}),
        quoteMalformed: true,
      })
      const versions = loaded.snapshot.nodes.reduce((n, node) => n + node.previousVersions, 0)
      console.log(
        `Lore：${loaded.snapshot.nodes.length} 个节点；${versions} 个旧版本不迁移` +
          (loaded.snapshot.recallEvents === null
            ? ''
            : `；${loaded.snapshot.recallEvents} 条召回事件不迁移`),
      )
      const preview = await previewImport(snap, base.plan, base.imports)
      printPlan(base.plan, preview, values.verbose)
      if (!values.sync || base.plan.errors.length) {
        const staleTime =
          loaded.exportedAt && !base.plan.errors.length
            ? staleAgainst(loaded.exportedAt, await loreDataTimeIn(snap.tx), preview, {
                items: [],
                goneFromLore: [],
              })
            : null
        return { plan: base.plan, preview, sync: null, staleTime }
      }
      if (config.masterKey) await verifyMasterKey(database.db, target, config.masterKey)
      const sync = await planSync(snap, base.plan, loaded.snapshot, base.imports)
      const staleTime = loaded.exportedAt
        ? staleAgainst(loaded.exportedAt, await loreDataTimeIn(snap.tx), preview, sync)
        : null
      return { plan: base.plan, preview, sync, staleTime }
    })

    if (plan.errors.length) {
      const lines = plan.errors.map((e) =>
        e.kind === 'secretNotFound'
          ? `  --secret 指定的 ${e.uri} 在 Lore 里不存在`
          : `  --exclude 指定的 ${e.uri} 在 Lore 里不存在`,
      )
      console.error(`\n计划有错误，不能执行：\n${lines.join('\n')}`)
      return 2
    }
    if (sync) printSync(sync, values.verbose)
    if (staleTime) {
      console.log(
        yellow(
          `\n注意：导出文件早于已写入数据（${staleTime.toISOString()}），写入可能覆盖同步内容。`,
        ),
      )
    }
    if (!values.apply) {
      const created = preview.targets.filter((t) => t.state === 'new').length
      const updated = sync ? `、按 Lore 更新 ${syncOf(sync, 'update').length} 条` : ''
      console.log(
        `\n${dim(`以上是计划，没有写入任何数据。确认无误后加 --apply 执行：新建 ${created} 条${updated}。`)}`,
      )
      return 0
    }
    if (staleTime && !values['confirm-stale']) {
      throw new UsageError('导出文件早于已写入数据；若仍要写入请加上 --confirm-stale')
    }

    try {
      assertExecutable(plan, config.masterKey)
    } catch (err) {
      if (!(err instanceof MemoryError)) throw err
      throw new UsageError('要导入机密节点，需要设置与服务相同的 KIOKU_MASTER_KEY')
    }
    if (config.masterKey && plan.targets.some((t) => !t.isSoul && t.sensitivity === 'secret')) {
      if (!(await verifyMasterKey(database.db, target, config.masterKey))) {
        console.warn(
          yellow(
            '库里还没有加密过的数据，无法确认 KIOKU_MASTER_KEY 与服务一致，请自行核对',
            process.stderr,
          ),
        )
      }
    }

    const result = await applyImport(target, plan)
    printResult(plan, result)
    const synced = sync ? await applySync(target, sync) : null
    if (synced) printSyncResult(synced)
    if (result.created.length || synced?.updated.length) {
      await requestBackfill(databaseUrlOf(config)).catch((err: unknown) =>
        console.warn('没能安排向量补齐，服务下次启动时会补上', err),
      )
    }
    if (result.failed.length || result.secretAlreadyImported.length || synced?.failed.length) {
      return 1
    }
    return 0
  } finally {
    await database.close()
  }
}

export function runImportLore(argv: string[]): Promise<number> {
  return runCli(IMPORT_LORE_HELP, importLoreMain, argv)
}

async function resolveTarget(
  db: Db,
  username: string,
  circleArg: string | null,
): Promise<{ circleId: string; accountId: string }> {
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.username, username))
  if (!account) throw new UsageError(`账号不存在：${username}`)

  const memberships = await db
    .select({
      circleId: circleMembers.circleId,
      role: circleMembers.role,
      kind: circles.kind,
      slug: circles.slug,
    })
    .from(circleMembers)
    .innerJoin(circles, eq(circles.id, circleMembers.circleId))
    .where(eq(circleMembers.accountId, account.id))

  if (circleArg) {
    const matched = memberships.find((m) => m.circleId === circleArg || m.slug === circleArg)
    if (!matched) throw new UsageError(`${username} 不是记忆圈 ${circleArg} 的成员`)
    if (matched.role !== 'owner') throw new UsageError(`${username} 不是该记忆圈的所有者`)
    return { circleId: matched.circleId, accountId: account.id }
  }

  const ownedShared = memberships.filter((m) => m.kind === 'shared' && m.role === 'owner')
  if (ownedShared.length === 1) {
    return { circleId: ownedShared[0]!.circleId, accountId: account.id }
  }
  if (ownedShared.length > 1) {
    throw new UsageError(`${username} 拥有多个共享记忆圈，用 --circle 指定`)
  }
  const ownedPersonal = memberships.find((m) => m.kind === 'personal' && m.role === 'owner')
  if (!ownedPersonal) throw new UsageError(`${username} 没有可导入的记忆圈`)
  return { circleId: ownedPersonal.circleId, accountId: account.id }
}

const WARNINGS: Record<LoreWarningKind, (uri: string) => string> = {
  credentialPath: (uri) => `${uri} 的路径疑似凭据，未用 --secret 标记`,
  credentialContent: (uri) => `${uri} 的正文疑似含密码或令牌，未用 --secret 标记`,
  credentialExtras: (uri) => `${uri} 的触发场景或关键词疑似含密码或令牌，未用 --secret 标记`,
  secretExtras: (uri) => `${uri} 的触发场景或关键词疑似含凭据：机密只加密正文，这两项仍为明文`,
  disclosureTruncated: (uri) => `${uri} 的触发场景超过 ${MAX_DISCLOSURE} 字，已截断`,
}

function counts(parts: [label: string, count: number, always?: boolean, note?: string][]): string {
  return parts
    .filter(([, count, always]) => always || count > 0)
    .map(([label, count, , note]) => `${label} ${count} 条${note ?? ''}`)
    .join('，')
}

const VERBOSE_NOTE = '（--verbose 逐条列出）'

function list(heading: string, lines: string[], styleHeading?: (text: string) => string): void {
  if (!lines.length) return
  console.log(`\n${styleHeading ? styleHeading(`${heading}：`) : `${heading}：`}`)
  for (const line of lines) console.log(`  ${line}`)
}

function personaLine(plan: ImportPlan, preview: ImportPreview): string {
  const { slug, name } = plan.persona
  if (!preview.personaExists && !preview.createsPersona) {
    return `这次没有要写入的 core://soul，人格 ${slug} 也不存在：不新建，新建接入实例的默认人格为空`
  }
  return plan.targets.some((t) => t.isSoul)
    ? `core://soul 导入为 ${slug}（不存在时新建为「${name}」）`
    : `这次没有要导入的 core://soul，不新建人格；已有的人格 ${slug} 照常用，新建的接入实例和还没有默认人格的接入实例设成它`
}

function targetLine({ item, state, current }: TargetPreview): string {
  const secret = state === 'new' ? item.sensitivity === 'secret' : current.some((c) => c.secret)
  const sensitivity = secret ? 'secret' : item.sensitivity
  const dest = item.isSoul
    ? `人格 ${item.personaSlug}:${item.traitKey}`
    : `${item.targetCircleKind === 'personal' ? '个人圈' : '共享圈'}${item.topics.length ? ` [${item.topics.join(',')}]` : ''}`
  const prio = `P${item.priority}`
  const title = loreTitle(item.content, item.legacyUri, secret)
  return `${title}  ${item.legacyUri} → ${dest}  ${SENSITIVITY_NAMES[sensitivity]} · ${prio}`
}

function currentNote({ current }: TargetPreview): string {
  const notes = current.flatMap((c) =>
    c.shortId === null ? ['已在 Kioku 中删除'] : [`当前词条 ${c.shortId}`],
  )
  return notes.length ? `（${notes.join('；')}）` : ''
}

function printPlan(plan: ImportPlan, preview: ImportPreview, verbose: boolean): void {
  console.log(`\n${bold('人格')}：${personaLine(plan, preview)}`)
  if (plan.clients.length) {
    console.log(`\n${bold('接入实例')}：`)
    for (const mapping of plan.clients) {
      const targets = mapping.clients.map((c) =>
        c.create ? `${c.slug}（新建，类型 ${c.runtimeFamily}）` : `${c.slug}（已有）`,
      )
      console.log(`  ${mapping.runtime} → ${targets.join('、')}`)
    }
  }

  const of = (state: LoreTargetState) => preview.targets.filter((t) => t.state === state)
  const created = of('new')
  const imported = of('imported')
  const moved = of('moved')
  console.log(
    `\n${bold('计划')}：${counts([
      ['新建', created.length, true],
      ['已导入', imported.length, true, verbose || !imported.length ? '' : VERBOSE_NOTE],
      ['Lore 里换了路径', moved.length],
      ['不导入', plan.skipped.length],
    ])}`,
  )
  list(`新建（${created.length} 条）`, created.map(targetLine), green)
  if (verbose) {
    list(
      `已导入（${imported.length} 条），不再写入`,
      imported.map((t) => `${targetLine(t)}${currentNote(t)}`),
      dim,
    )
  }
  list(
    `Lore 里换了路径（${moved.length} 条），不在新位置新建；之前导入的留在原处`,
    moved.map((t) => `${targetLine(t)}${currentNote(t)}`),
    yellow,
  )
  list(
    `不导入（${plan.skipped.length} 条）`,
    plan.skipped.map((s) => `${s.source}：${s.reason}`),
    yellow,
  )
  list(
    `丢弃的关键词（${plan.droppedKeywords.length} 个）`,
    plan.droppedKeywords.map((k) => `${k.source}「${k.keyword}」：${k.reason}`),
    dim,
  )
  const secretIgnored = preview.targets.flatMap(({ item, state, current }) =>
    state !== 'new' && item.sensitivity === 'secret'
      ? current
          .filter((c) => c.shortId !== null && !c.secret)
          .map(
            (c) =>
              `${item.source} 之前导入过，现在是明文，--secret 对它不生效：请在管理界面把 ${c.shortId} 改为机密`,
          )
      : [],
  )
  const warnings = [...plan.warnings.map((w) => WARNINGS[w.kind](w.legacyUri)), ...secretIgnored]
  list(`提醒（${warnings.length} 条）`, warnings, yellow)
}

function printResult(plan: ImportPlan, result: ImportResult): void {
  console.log(`\n${green('导入完成')}：`)
  console.log(
    result.personaUsed
      ? `  人格 ${plan.persona.slug}：${result.personaCreated ? '新建' : '已有'}`
      : `  人格 ${plan.persona.slug} 不存在，这次也没有要写入的 core://soul：没有新建，新建接入实例的默认人格为空`,
  )
  if (result.clientsCreated.length)
    console.log(`  新建接入实例：${result.clientsCreated.join('、')}`)
  if (result.clientsGivenPersona.length) {
    console.log(`  设为默认人格 ${plan.persona.slug}：${result.clientsGivenPersona.join('、')}`)
  }
  if (result.clientsOtherPersona.length) {
    console.log(
      `  这些接入实例在用别的人格，core://soul 不会进入它们的启动加载：${result.clientsOtherPersona.join('、')}`,
    )
  }
  console.log(
    `  新建 ${result.created.length} 条；已导入、跳过 ${result.previouslyImported.length} 条` +
      `（包括导入后在 Kioku 里删除或移动了的）`,
  )
  for (const { legacyUri, shortId } of result.movedInLore) {
    console.log(
      shortId
        ? `  跳过 ${legacyUri}：Lore 里换了路径，之前导入的那条还在 ${shortId}，没有在新位置再建一条`
        : `  跳过 ${legacyUri}：Lore 里换了路径，之前导入的那条在 Kioku 里删除了，没有在新位置再建一条`,
    )
  }
  for (const { legacyUri, shortId } of result.secretAlreadyImported) {
    console.log(
      yellow(
        `  注意 ${legacyUri}：之前导入过，现在还是明文，这次的 --secret 没有生效。请在管理界面把 ${shortId} 改为机密（会同时清除历史里的明文）`,
      ),
    )
  }
  for (const f of result.failed) console.log(red(`  失败 ${f.source}：${f.reason}`))
  if (result.clientsCreated.length) {
    console.log('  新建的接入实例暂无访问密钥：在管理界面的「接入」页为要接入的实例签发')
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

function syncLine(item: SyncItem): string {
  const head = `${item.title}  ${item.shortId} (${item.legacyUri})`
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

const NOT_SYNCED: [SyncState, string, (n: number) => string][] = [
  [
    'edited',
    '在 Kioku 里改过',
    (n) => `导入后在 Kioku 里改过或迁移过（${n} 条），不同步；要跟上 Lore 就在管理界面手动改`,
  ],
  [
    'moved',
    'Lore 里换了路径',
    (n) => `Lore 里换了路径（${n} 条），不同步；移动可能改变记忆圈与可见范围，需要手动处理`,
  ],
  ['deleted', '在 Kioku 里删除了', (n) => `在 Kioku 里删除了（${n} 条），不同步`],
  [
    'skipped',
    '这次不导入',
    (n) => `这次的导入计划不导入（${n} 条），没有同步；原因见上面的「不导入」`,
  ],
  ['unmapped', '没有映射到', (n) => `这次的计划没有映射到（${n} 条），没有同步`],
  ['unreadable', '读不出来', (n) => `读不出来（${n} 条），没有同步`],
]

function printSync(sync: SyncPlan, verbose: boolean): void {
  const current = syncOf(sync, 'current')
  const update = syncOf(sync, 'update')
  const gone = sync.goneFromLore
  console.log(
    `\n${bold('同步导入过的节点')}：${counts([
      ['按 Lore 更新', update.length, true],
      ['已是最新', current.length, true, verbose || !current.length ? '' : VERBOSE_NOTE],
      ...NOT_SYNCED.map(([state, label]): [string, number] => [label, syncOf(sync, state).length]),
      ['Lore 里已经没有', gone.length],
    ])}`,
  )
  list(`按 Lore 更新（${update.length} 条）`, update.map(syncLine), green)
  if (verbose) list(`已是最新（${current.length} 条）`, current.map(syncLine), dim)
  for (const [state, , heading] of NOT_SYNCED) {
    const items = syncOf(sync, state)
    list(heading(items.length), items.map(syncLine), yellow)
  }
  list(`Lore 里已经没有这个节点（${gone.length} 条），Kioku 里保留；要删就在管理界面删`, gone, dim)
}

function printSyncResult(result: SyncResult): void {
  console.log(`\n${green('同步完成')}：更新 ${result.updated.length} 条`)
  for (const f of result.failed) console.log(red(`  失败 ${f.source}：${f.reason}`))
}
