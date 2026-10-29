import { readFile } from 'node:fs/promises'
import { buffer } from 'node:stream/consumers'
import { parseArgs } from 'node:util'

import { restoreBackup } from '../backup/restore'
import { backupSettingsView } from '../backup/settings'
import { fetchBackup } from '../backup/storage'
import { loadConfig } from '../config'
import { prepareMasterKey } from '../crypto/rotation'
import { assertRuntimeRole, connect } from '../db/client'
import { runCli, UsageError } from './common'

const HELP = `把备份恢复到一个新实例。

用法：node dist/restore.mjs --file <备份文件>
      node dist/restore.mjs --s3-endpoint <接口地址> --s3-bucket <存储桶> [--s3-prefix <前缀>] [--s3-object <对象名>]

恢复到新建的空库，恢复之前不要启动服务：核对备份的格式版本、主密钥与迁移，先把迁移执行到做备份时的位置，
再按原来的 id 写回全部数据，并执行这个版本新增的迁移（较早版本做的备份也能恢复）。写回与新增的迁移在一个事务里，
失败时数据一条也不留下，可以直接重试。库里已经有账号或空间时拒绝恢复。

恢复之后启动服务：向量在后台重新生成，生成完之前召回只靠全文检索；所有人要重新登录，Key 照常可用。

  --file <备份文件>       backup 命令做出的文件；写 - 时从标准输入读
  --s3-endpoint <地址>    从对象存储取定时备份：接口地址、存储桶与前缀和实例设置里填的一样
  --s3-bucket <存储桶>
  --s3-prefix <前缀>      备份所在的目录，没填过就不加
  --s3-object <对象名>    取这一份（完整的对象名）；不加时取前缀下最新的一份

环境变量：
  DATABASE_URL               新实例的数据库
  KIOKU_MASTER_KEY           做备份时的主密钥
  KIOKU_MASTER_KEY_PREVIOUS  备份之后轮换过主密钥时：KIOKU_MASTER_KEY 配新的，这里配做备份时的那把
  AWS_ACCESS_KEY_ID          从存储桶取备份时用的访问密钥
  AWS_SECRET_ACCESS_KEY
  AWS_REGION                 存储的区域，默认 us-east-1`

const readInput = (file: string): Promise<Buffer> =>
  file === '-' ? buffer(process.stdin) : readFile(file)

// 从存储桶取备份：参数指明位置，访问密钥从环境变量读（不出现在命令行里）
async function download(values: {
  's3-endpoint': string
  's3-bucket'?: string | undefined
  's3-prefix'?: string | undefined
  's3-object'?: string | undefined
}): Promise<Buffer> {
  const bucket = values['s3-bucket']
  if (!bucket) throw new UsageError('缺少 --s3-bucket')
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new UsageError('从存储桶取备份需要环境变量 AWS_ACCESS_KEY_ID 与 AWS_SECRET_ACCESS_KEY')
  }
  const { object, file } = await fetchBackup(
    {
      endpoint: values['s3-endpoint'],
      region: process.env.AWS_REGION || 'us-east-1',
      bucket,
      accessKeyId,
      secretAccessKey,
    },
    (values['s3-prefix'] ?? '').replace(/^\/+|\/+$/g, ''),
    values['s3-object'] ?? null,
  )
  console.log(`从存储桶取了 ${object}（${(file.length / 1024).toFixed(1)} KB）`)
  return file
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      's3-endpoint': { type: 'string' },
      's3-bucket': { type: 'string' },
      's3-prefix': { type: 'string' },
      's3-object': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  if (values.help) {
    console.log(HELP)
    return
  }
  const endpoint = values['s3-endpoint']
  if (Boolean(values.file) === Boolean(endpoint)) {
    throw new UsageError('用 --file 指定备份文件，或者用 --s3-endpoint 等从存储桶取，二选一')
  }
  const config = loadConfig()
  if (!config.masterKey) {
    throw new UsageError('备份用主密钥加密：需要设置做备份时的 KIOKU_MASTER_KEY')
  }
  const file = endpoint
    ? await download({ ...values, 's3-endpoint': endpoint })
    : await readInput(values.file!)
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
    // 沿用了备份设置：试恢复的实例和正在用的实例往同一个目录写，会互相把对方的备份当旧的删掉
    const backup = await backupSettingsView(database.db)
    if (backup.configured) {
      console.warn(
        `\n恢复出的实例沿用了备份设置，启动后会接着往 ${backup.bucket}/${backup.prefix ?? ''} 定时备份。` +
          '只是试恢复的话，启动后先在实例设置里清掉备份设置，别和正在用的实例往同一个目录写。',
      )
    }
    console.log('\n现在可以启动服务：向量会在后台重新生成，所有人需要重新登录。')
  } finally {
    await database.close()
  }
}

runCli(HELP, main)
