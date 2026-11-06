import { describe, expect, it } from 'vitest'

import { parseWorkers, workerDatabaseUrl } from '../workers'

describe('集成测试的并行数', () => {
  it('没设时串行', () => {
    expect(parseWorkers(undefined)).toBe(1)
    expect(parseWorkers('')).toBe(1)
  })

  it('设了就按它并行，写错了直接报错，不悄悄退回串行', () => {
    expect(parseWorkers('3')).toBe(3)
    for (const bad of ['0', '-1', '2.5', 'abc']) expect(() => parseWorkers(bad)).toThrow()
  })
})

describe('每个 worker 连哪个库', () => {
  const url = 'postgres://kioku:kioku@127.0.0.1:5432/kioku?sslmode=disable'

  it('串行时就用给的库', () => {
    expect(workerDatabaseUrl(url, 1, undefined)).toBe(url)
    expect(workerDatabaseUrl(url, 1, '2')).toBe(url)
  })

  it('并行时库名后加 worker 编号，其余不变', () => {
    expect(workerDatabaseUrl(url, 3, '2')).toBe(
      'postgres://kioku:kioku@127.0.0.1:5432/kioku_w2?sslmode=disable',
    )
  })

  it('编号不在范围里、或者连接串没有库名时报错', () => {
    for (const id of [undefined, '0', '4', 'x'])
      expect(() => workerDatabaseUrl(url, 3, id)).toThrow()
    expect(() => workerDatabaseUrl('postgres://kioku@127.0.0.1:5432', 3, '1')).toThrow()
  })
})
