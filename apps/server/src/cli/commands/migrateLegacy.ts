import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { parseArgs } from 'node:util'

import type { LegacyUpgradeSummary } from '@kioku/contracts'

import { loadConfig } from '../../config'
import { parseMasterKey } from '../../crypto/envelope'
import { keyIdOf, type MasterKey } from '../../crypto/keyring'
import { assertRuntimeRole, connect } from '../../db/client'
import { pendingMigrations } from '../../db/migrate'
import {
  applyLegacyMigration,
  planLegacyMigration,
  readLegacyDatabase,
  readLegacyInstanceBackup,
  readLegacySpaceExport,
  type LegacyMigrationPlanSummary,
  type LegacySnapshot,
} from '../../importer/kiokuLegacy'
import { migrateLegacyInPlace } from '../../importer/legacyInPlace'
import { DATABASE_ENV_HELP, databaseUrlOf, runCli, UsageError } from '../common'
import { bold, dim, formatRows, green, renderStrataBox, yellow } from '../format'

export const MIGRATE_LEGACY_HELP = `从旧版 Kioku（v0.5.0 及更早空间结构）迁移到新版记忆圈架构。

用法：kioku-ctl migrate-legacy --in-place [选项]
      kioku-ctl migrate-legacy --from-db <旧库连接串> [选项]
      kioku-ctl migrate-legacy --backup <旧版备份文件> [选项]
      kioku-ctl migrate-legacy --space-export <旧版空间导出文件> --account <用户名> [选项]
      node dist/migrate-legacy.mjs [选项]

四种迁移来源四选一（不能同时指定）：
  --in-place              就地升级：服务配置的库还是旧版结构时，旧对象移进 kioku_legacy schema 保留，
                          在同一个库里建新结构并迁入；和管理界面升级页的一键迁移是同一份逻辑。先停服务
  --from-db <连接串>      直连旧版 Kioku PostgreSQL 数据库只读迁入空新库（也可设 LEGACY_DATABASE_URL）
  --backup <文件>         从旧版全实例备份文件（KIOKUBK1）迁入空新库；写 - 从标准输入读
  --space-export <文件>   将旧版空间导出文件（KIOKUSX1）迁入已有实例指定账号的新建共享圈与个人圈

默认只规划并校验主密钥与映射统计（干跑，不写库）；确认无误后加 --apply 执行写入。
说明：全实例迁移保留账号、登录密码哈希、shared 共享内容、user 个人圈内容、persona 独立人格设定、
      app -> runtime 切面、联系人、对话、托管凭据与密码库连接；旧版访问密钥、软删除垃圾与
      backup 对象存储设置不会迁移（请在迁移后重新签发透镜访问密钥）。

  --account <用户名>              --space-export 时指定写入哪个已有账号下（目标库唯一账号时可省）
  --circle-name <名称>            --space-export 时覆盖新建共享圈的名称
  --legacy-master-key-env <变量>  指定存放旧主密钥的环境变量名（默认 LEGACY_KIOKU_MASTER_KEY，未设时回退 KIOKU_MASTER_KEY）
  --passphrase-env <变量>         指定存放空间导出文件口令的环境变量名（默认 KIOKU_EXPORT_PASSPHRASE）
  --apply                         执行写入；不加时仅输出迁移计划
  --json                          以 JSON 输出计划或结果摘要

环境变量：
${DATABASE_ENV_HELP}
  LEGACY_DATABASE_URL        旧版 PostgreSQL 只读连接串（与 --from-db 等效）
  LEGACY_KIOKU_MASTER_KEY    旧实例主密钥（base64，支持跨密钥迁移；同密钥时可只配 KIOKU_MASTER_KEY）
  KIOKU_MASTER_KEY           目标新实例主密钥，加密数据重封时必填，与服务相同
  KIOKU_MASTER_KEY_PREVIOUS  目标新实例轮换期间的上一把主密钥，与服务相同
  KIOKU_EXPORT_PASSPHRASE    解开 --space-export 文件的导出口令`

function parseLegacyOptions(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        'in-place': { type: 'boolean', default: false },
        'from-db': { type: 'string' },
        backup: { type: 'string' },
        'space-export': { type: 'string' },
        account: { type: 'string' },
        'circle-name': { type: 'string' },
        'legacy-master-key-env': { type: 'string' },
        'passphrase-env': { type: 'string' },
        apply: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }).values
  } catch (err) {
    throw new UsageError((err as Error).message)
  }
}

function resolveLegacyMasterKey(
  envVarName: string | undefined,
  fallbackKey: MasterKey | null,
): MasterKey | null {
  if (envVarName) {
    const raw = process.env[envVarName]
    if (!raw) {
      throw new UsageError(`指定的旧主密钥环境变量 ${envVarName} 未设置或为空`)
    }
    const prevRaw = process.env[`${envVarName}_PREVIOUS`]
    const current = parseMasterKey(raw)
    if (!prevRaw) return current
    const previous = parseMasterKey(prevRaw)
    if (keyIdOf(previous) === keyIdOf(current)) return current
    return { current, previous }
  }
  const rawLegacy = process.env.LEGACY_KIOKU_MASTER_KEY
  if (rawLegacy) {
    const current = parseMasterKey(rawLegacy)
    const prevRaw = process.env.LEGACY_KIOKU_MASTER_KEY_PREVIOUS
    if (!prevRaw) return current
    const previous = parseMasterKey(prevRaw)
    return keyIdOf(previous) === keyIdOf(current) ? current : { current, previous }
  }
  return fallbackKey
}

async function promptHidden(label: string): Promise<string> {
  process.stderr.write(label)
  let muted = true
  const output = new Writable({
    write(chunk, _encoding, cb) {
      if (!muted) process.stderr.write(chunk)
      cb()
    },
  })
  const rl = createInterface({ input: process.stdin, output, terminal: true })
  try {
    return await new Promise<string>((resolve) => {
      rl.question('', (answer) => {
        muted = false
        process.stderr.write('\n')
        resolve(answer)
      })
    })
  } finally {
    rl.close()
  }
}

async function readPassphrase(envName: string | undefined): Promise<string> {
  const varName = envName || 'KIOKU_EXPORT_PASSPHRASE'
  const fromEnv = process.env[varName]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (envName) {
    throw new UsageError(`指定的口令环境变量 ${varName} 未设置或为空`)
  }
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `解开 --space-export 需要口令：请设置环境变量 ${varName}（或使用 --passphrase-env 指定变量名）`,
    )
  }
  const entered = await promptHidden('请输入旧版空间导出文件口令：')
  if (!entered) throw new UsageError('导出文件口令不能为空')
  return entered
}

async function readBinaryInput(file: string): Promise<Buffer> {
  if (file === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  }
  return readFile(file)
}

function renderSummary(summary: LegacyMigrationPlanSummary, applied: boolean): void {
  const heading = applied ? '旧版迁移完成' : '旧版迁移计划（干跑预览）'
  const statusText = applied
    ? green(
        `✓ 已写入新库（${summary.entries.entry + summary.entries.fact + summary.entries.episode} 条词条/事实/摘要）`,
      )
    : bold('预览通过（未写入，加 --apply 执行）')

  const circleNames = summary.sharedCircles
    .map((c) => `${c.name} (${c.slug}, ${c.memberCount} 人)`)
    .join('、')

  const rows: [string, string][] = [
    ['状态', statusText],
    ['迁移模式', summary.mode === 'instance' ? '全实例重建迁入' : '单空间迁入共享圈 + 个人圈'],
    ['来源版本', summary.sourceVersion],
    ...(summary.accounts > 0
      ? [['账号与个人圈', `${summary.accounts} 个`] as [string, string]]
      : []),
    ['共享记忆圈', `${summary.sharedCircles.length} 个${circleNames ? `：${circleNames}` : ''}`],
    ['独立人格', `${summary.personas} 个人格，${summary.personaTraits} 条设定`],
    [
      '接入与联系人',
      `${summary.clients} 个接入实例，${summary.groupRules} 条群规则，${summary.subjects} 个联系人，${summary.conversations} 个会话`,
    ],
    ['凭据与密码库', `${summary.vaultConnections} 个连接，${summary.credentials} 条凭据`],
    [
      '记忆转换',
      `正式词条 ${summary.entries.entry}（含机密 ${summary.entries.secret}）、联系人事实 ${summary.entries.fact}、会话摘要 ${summary.entries.episode}；旧坐标兜底 ${summary.legacyUris} 条`,
    ],
    ...(summary.settings > 0 ? [['实例设置', `${summary.settings} 项`] as [string, string]] : []),
  ]

  if (process.stdout.isTTY) {
    console.log(
      renderStrataBox(heading, formatRows(rows, { stream: process.stdout }), {
        stream: process.stdout,
      }),
    )
  } else {
    console.log(`${heading}`)
    for (const [k, v] of rows) console.log(`  ${k}：${v}`)
  }

  if (summary.skippedDeletedMemories > 0 || summary.skippedDeletedCredentials > 0) {
    const info = `已忽略软删除记录：旧记忆 ${summary.skippedDeletedMemories} 条、旧凭据 ${summary.skippedDeletedCredentials} 条`
    console.log(process.stdout.isTTY ? dim(info, process.stdout) : info)
  }

  for (const w of summary.warnings) {
    console.warn(process.stderr.isTTY ? yellow(`! ${w}`, process.stderr) : `! ${w}`)
  }

  if (applied) {
    console.log('\n后续步骤：向量将在服务启动后由后台补齐，旧版访问密钥需在管理界面重新签发。')
  }
}

async function migrateLegacyMain(argv: string[]): Promise<number> {
  const values = parseLegacyOptions(argv)
  if (values.help) {
    console.log(MIGRATE_LEGACY_HELP)
    return 0
  }

  const fromDbFlag = values['from-db']
  const backupPath = values.backup
  const spaceExportPath = values['space-export']
  const envFromDb =
    !fromDbFlag && !backupPath && !spaceExportPath ? process.env.LEGACY_DATABASE_URL : undefined
  const dbUrl = fromDbFlag ?? envFromDb

  const inPlace = values['in-place']
  const selectedCount =
    Number(Boolean(dbUrl)) +
    Number(Boolean(backupPath)) +
    Number(Boolean(spaceExportPath)) +
    Number(inPlace)
  if (selectedCount === 0) {
    throw new UsageError(
      '必须指定 --in-place、--from-db（或 LEGACY_DATABASE_URL）、--backup 或 --space-export 中的一个来源',
    )
  }
  if (selectedCount > 1) {
    throw new UsageError('--in-place、--from-db、--backup 与 --space-export 只能选一个')
  }
  if (inPlace) return migrateInPlace(values)
  if (!spaceExportPath && (values.account || values['circle-name'])) {
    throw new UsageError('--account 与 --circle-name 仅在使用 --space-export 时适用')
  }
  if (spaceExportPath && values['legacy-master-key-env']) {
    throw new UsageError('--space-export 使用导出口令解密，不需要 --legacy-master-key-env')
  }

  const config = loadConfig()
  const legacyMasterKey = spaceExportPath
    ? null
    : resolveLegacyMasterKey(values['legacy-master-key-env'], config.masterKey)

  let snapshot: LegacySnapshot
  if (spaceExportPath) {
    const passphrase = await readPassphrase(values['passphrase-env'])
    const file = await readBinaryInput(spaceExportPath)
    snapshot = await readLegacySpaceExport(file, passphrase)
  } else if (backupPath) {
    if (!legacyMasterKey) {
      throw new UsageError(
        '解开 --backup 需要配置旧主密钥：请设置 LEGACY_KIOKU_MASTER_KEY（同密钥迁移时设置 KIOKU_MASTER_KEY）',
      )
    }
    const file = await readBinaryInput(backupPath)
    snapshot = readLegacyInstanceBackup(file, legacyMasterKey)
  } else {
    snapshot = await readLegacyDatabase(dbUrl!)
  }

  const database = connect(databaseUrlOf(config), { max: 2 })
  try {
    await assertRuntimeRole(database.db)
    const pending = await pendingMigrations(database.db, config.migrationsFolder)
    if (pending === null) {
      throw new Error(
        '目标数据库存在不兼容或来自其他版本的迁移：请使用空白数据库启动一次当前版本后再迁移',
      )
    }
    if (pending > 0) {
      throw new Error(
        '目标数据库尚未完成建表迁移：请先用当前版本启动一次 Kioku（不要注册账号）完成建表，再执行迁移',
      )
    }

    const plan = await planLegacyMigration(database.db, snapshot, {
      legacyMasterKey,
      targetMasterKey: config.masterKey,
      ...(values.account ? { accountUsername: values.account } : {}),
      ...(values['circle-name'] ? { circleName: values['circle-name'] } : {}),
    })

    if (!values.apply) {
      if (values.json)
        console.log(JSON.stringify({ applied: false, summary: plan.summary }, null, 2))
      else renderSummary(plan.summary, false)
      return 0
    }

    const result = await applyLegacyMigration(database.db, plan, {
      targetMasterKey: config.masterKey,
    })
    if (values.json) {
      console.log(
        JSON.stringify(
          { applied: true, allocatedShortIds: result.allocatedShortIds, summary: result.summary },
          null,
          2,
        ),
      )
    } else {
      renderSummary(result.summary, true)
    }
    return 0
  } finally {
    await database.close()
  }
}

async function migrateInPlace(values: ReturnType<typeof parseLegacyOptions>): Promise<number> {
  if (values.account || values['circle-name']) {
    throw new UsageError('--account 与 --circle-name 仅在使用 --space-export 时适用')
  }
  const config = loadConfig()
  const database = connect(databaseUrlOf(config), { max: 1 })
  try {
    await assertRuntimeRole(database.db)
    const result = await migrateLegacyInPlace(database.db, {
      migrationsFolder: config.migrationsFolder,
      masterKey: config.masterKey,
      legacyMasterKey: resolveLegacyMasterKey(values['legacy-master-key-env'], config.masterKey),
      apply: values.apply,
    })
    if (values.json) console.log(JSON.stringify(result, null, 2))
    else renderInPlace(result.summary, result.applied)
    return 0
  } finally {
    await database.close()
  }
}

function renderInPlace(summary: LegacyUpgradeSummary, applied: boolean): void {
  const heading = applied ? '就地升级完成' : '就地升级预览（已回滚）'
  const rows: [string, string][] = [
    [
      '状态',
      applied
        ? green('✓ 已迁入新结构，旧对象保留在 kioku_legacy')
        : bold('预览通过（未写入，加 --apply 执行）'),
    ],
    ['账号与个人圈', `${summary.accounts} 个`],
    ['共享记忆圈', `${summary.sharedCircles.length} 个`],
    ['独立人格', `${summary.personas} 个人格，${summary.personaTraits} 条设定`],
    [
      '接入与联系人',
      `${summary.clients} 个接入实例，${summary.subjects} 个联系人，${summary.conversations} 个会话`,
    ],
    ['凭据与密码库', `${summary.vaultConnections} 个连接，${summary.credentials} 条凭据`],
    [
      '记忆转换',
      `正式词条 ${summary.entries.entry}（含机密 ${summary.entries.secret}）、联系人事实 ${summary.entries.fact}、会话摘要 ${summary.entries.episode}`,
    ],
    ['旧访问密钥', `${summary.legacyKeys} 个，迁移后失效，需重新签发`],
  ]
  if (process.stdout.isTTY) {
    console.log(
      renderStrataBox(heading, formatRows(rows, { stream: process.stdout }), {
        stream: process.stdout,
      }),
    )
  } else {
    console.log(heading)
    for (const [k, v] of rows) console.log(`  ${k}：${v}`)
  }
  for (const w of summary.warnings) {
    console.warn(process.stderr.isTTY ? yellow(`! ${w}`, process.stderr) : `! ${w}`)
  }
  if (applied)
    console.log(
      '\n后续步骤：重启服务；在管理界面重新签发访问密钥，客户端运行 npx @kioku-memory/cli migrate 重新接入。',
    )
}

export function runMigrateLegacy(argv: string[]): Promise<number> {
  return runCli(MIGRATE_LEGACY_HELP, migrateLegacyMain, argv)
}
