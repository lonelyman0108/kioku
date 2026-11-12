import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { databaseUrlOf, UsageError } from '../cli/common'
import { loadConfig } from '../config'
import { readDataFile, resolveDatabaseUrl, writeDataFile } from '../dataDir'

describe('数据目录与数据库连接的读取顺序', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kioku-data-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('kioku.json 写成 600，经临时文件改名换上，不留下临时文件', async () => {
    await writeDataFile(dir, { databaseUrl: 'postgres://a:b@127.0.0.1/kioku' })
    await writeDataFile(dir, { databaseUrl: 'postgres://a:c@127.0.0.1/kioku' })
    expect((await stat(join(dir, 'kioku.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(dir)).toEqual(['kioku.json'])
    expect(JSON.parse(await readFile(join(dir, 'kioku.json'), 'utf8'))).toEqual({
      databaseUrl: 'postgres://a:c@127.0.0.1/kioku',
    })
  })

  it('目录不存在时建出来（700）', async () => {
    const nested = join(dir, 'a', 'b')
    await writeDataFile(nested, { databaseUrl: 'postgres://127.0.0.1/kioku' })
    expect((await stat(nested)).mode & 0o777).toBe(0o700)
  })

  it('环境变量优先，其次 kioku.json，都没有时为 null', async () => {
    expect(resolveDatabaseUrl({}, dir)).toBeNull()
    await writeDataFile(dir, { databaseUrl: 'postgres://127.0.0.1/from-file' })
    expect(resolveDatabaseUrl({}, dir)).toEqual({
      url: 'postgres://127.0.0.1/from-file',
      source: 'file',
    })
    expect(resolveDatabaseUrl({ DATABASE_URL: 'postgres://127.0.0.1/from-env' }, dir)).toEqual({
      url: 'postgres://127.0.0.1/from-env',
      source: 'env',
    })
  })

  it('读不懂的 kioku.json 报错，不当作没有配置', async () => {
    await writeFile(join(dir, 'kioku.json'), '{not json')
    expect(() => readDataFile(dir)).toThrow(/不是合法的 JSON/)
    await writeFile(join(dir, 'kioku.json'), '{"databaseUrl": 1}')
    expect(() => readDataFile(dir)).toThrow(/databaseUrl/)
    await writeFile(join(dir, 'kioku.json'), '{}')
    expect(readDataFile(dir)).toEqual({})
  })

  it('命令行工具与服务同一个读取顺序', async () => {
    const none = loadConfig({ KIOKU_DATA_DIR: dir })
    expect(none.database).toBeNull()
    expect(() => databaseUrlOf(none)).toThrow(UsageError)
    await writeDataFile(dir, { databaseUrl: 'postgres://127.0.0.1/from-file' })
    expect(databaseUrlOf(loadConfig({ KIOKU_DATA_DIR: dir }))).toBe(
      'postgres://127.0.0.1/from-file',
    )
    expect(
      databaseUrlOf(loadConfig({ KIOKU_DATA_DIR: dir, DATABASE_URL: 'postgres://127.0.0.1/env' })),
    ).toBe('postgres://127.0.0.1/env')
  })

  it('KIOKU_SETUP_CODE 太短时拒绝启动', () => {
    expect(() => loadConfig({ KIOKU_DATA_DIR: dir, KIOKU_SETUP_CODE: 'ab-cd' })).toThrow(
      /KIOKU_SETUP_CODE/,
    )
    expect(loadConfig({ KIOKU_DATA_DIR: dir, KIOKU_SETUP_CODE: 'abcd-efgh' }).setupCode).toBe(
      'abcd-efgh',
    )
  })
})
