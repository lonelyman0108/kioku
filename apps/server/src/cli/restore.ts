import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { restoreBackup } from '../backup/restore'
import { loadConfig } from '../config'
import { prepareMasterKey } from '../crypto/rotation'
import { assertRuntimeRole, connect } from '../db/client'
import { runCli, UsageError } from './common'

const HELP = `把备份恢复到一个新实例。

用法：node dist/restore.mjs --file <备份文件>

恢复到新建的空库，恢复之前不要启动服务：核对备份的格式版本、主密钥与迁移，先把迁移执行到做备份时的位置，
再按原来的 id 写回全部数据，并执行这个版本新增的迁移（较早版本做的备份也能恢复）。写回与新增的迁移在一个事务里，
失败时数据一条也不留下，可以直接重试。库里已经有账号或空间时拒绝恢复。

恢复之后启动服务：向量在后台重新生成，生成完之前召回只靠全文检索；所有人要重新登录，Key 照常可用。

  --file <备份文件>   backup 命令做出的文件；写 - 时从标准输入读

环境变量：
  DATABASE_URL               新实例的数据库
  KIOKU_MASTER_KEY           做备份时的主密钥
  KIOKU_MASTER_KEY_PREVIOUS  备份之后轮换过主密钥时：KIOKU_MASTER_KEY 配新的，这里配做备份时的那把`

async function readInput(file: string): Promise<Buffer> {
  if (file !== '-') return readFile(file)
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  if (!values.file) throw new UsageError('缺少 --file')
  const config = loadConfig()
  if (!config.masterKey) {
    throw new UsageError('备份用主密钥加密：需要设置做备份时的 KIOKU_MASTER_KEY')
  }
  const file = await readInput(values.file)
  const database = connect(config.databaseUrl, { max: 2 })
  try {
    await assertRuntimeRole(database.db)
    const { header, rows, upgraded } = await restoreBackup(database, {
      migrationsFolder: config.migrationsFolder,
      masterKey: config.masterKey,
      file,
    })
    const total = Object.values(rows).reduce((a, b) => a + b, 0)
    console.log(`恢复完成：备份做于 ${header.createdAt}（Kioku ${header.kioku}），写回 ${total} 行`)
    console.log(
      `  ${Object.entries(rows)
        .map(([table, n]) => `${table} ${n}`)
        .join('、')}`,
    )
    if (upgraded)
      console.log(`  备份来自较早的版本，写回之后执行了这个版本新增的 ${upgraded} 个迁移`)
    // 和服务启动时一样核对加密的数据：主密钥对不上时现在就说，不等启动时才被拒绝
    try {
      await prepareMasterKey(database.db, config.masterKey)
    } catch (err) {
      console.error(`数据已经写回，但服务会拒绝启动：${(err as Error).message}`)
      process.exitCode = 1
      return
    }
    console.log('\n现在可以启动服务：向量会在后台重新生成，所有人需要重新登录。')
  } finally {
    await database.close()
  }
}

runCli(HELP, main)
