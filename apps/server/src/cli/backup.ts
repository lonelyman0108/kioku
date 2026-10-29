import { open, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { createBackup } from '../backup/export'
import { loadConfig } from '../config'
import { assertRuntimeRole, connect } from '../db/client'
import { pendingMigrations } from '../db/migrate'

const HELP = `把整个实例备份成一个加密的文件。

用法：node dist/backup.mjs --out <文件>

备份包括账号、实例设置、空间与成员、应用与 Key，以及每个空间的全部内容（记忆与历史、对象、托管的凭据、
召回记录等），secret 与托管的凭据值仍是密文。不包括会话与登录计数（恢复后重新登录）、对话缓冲，
以及向量（恢复后重新生成）。服务运行期间也可以备份：各表读的是同一时刻的快照。
整份文件用主密钥派生的密钥加密，恢复时要配同一把主密钥。

  --out <文件>   写到这个文件，已存在时不覆盖；写 - 时输出到标准输出

环境变量：
  DATABASE_URL       Kioku 的数据库，与服务相同
  KIOKU_MASTER_KEY   与服务相同`

class UsageError extends Error {}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  const out = values.out
  if (!out) throw new UsageError('缺少 --out')
  const config = loadConfig()
  if (!config.masterKey) {
    throw new UsageError('备份用主密钥加密：需要设置与服务相同的 KIOKU_MASTER_KEY')
  }
  // 备份写到标准输出时，提示信息走标准错误
  const log = out === '-' ? console.error : console.log
  // 先建好文件再备份：文件已存在时不用白做一遍
  const handle = out === '-' ? null : await open(out, 'wx', 0o600)
  const database = connect(config.databaseUrl, { max: 2 })
  let written = false
  try {
    await assertRuntimeRole(database.db)
    if ((await pendingMigrations(database.db, config.migrationsFolder)) !== 0) {
      throw new Error('数据库的迁移与这个版本不一致：用与服务相同的版本备份')
    }
    const { file, summary } = await createBackup(database.db, config.masterKey)
    if (handle) await handle.writeFile(file)
    else {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(file, (err) => (err ? reject(err) : resolve())),
      )
    }
    written = true
    const rows = Object.entries(summary.rows).filter(([, n]) => n)
    log(
      `备份完成：${out === '-' ? '已输出到标准输出' : out}，${(summary.bytes / 1024).toFixed(1)} KB，主密钥标识 ${summary.keyId}`,
    )
    log(`  ${rows.map(([table, n]) => `${table} ${n}`).join('、')}`)
  } finally {
    await handle?.close()
    // 没写成的不留下空文件或半个文件
    if (handle && !written) await rm(out, { force: true })
    await database.close()
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\n${HELP}`)
    process.exitCode = 2
    return
  }
  const code = (err as { code?: string }).code
  console.error(
    code === 'EEXIST' ? '文件已存在，换一个文件名' : err instanceof Error ? err.message : err,
  )
  process.exitCode = 1
})
