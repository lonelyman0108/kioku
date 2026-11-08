import { describe, expect, it } from 'vitest'

import { knownTimeZone, lineChanges } from '../activity'

describe('正文增删的行数', () => {
  it('按行做多重集合的差：改了一行算加一删一，加在末尾只算加', () => {
    expect(lineChanges('一\n二\n三', '一\n二改\n三\n四')).toEqual({ added: 2, removed: 1 })
    expect(lineChanges('一', '一\n二')).toEqual({ added: 1, removed: 0 })
    expect(lineChanges('一\n二', '')).toEqual({ added: 1, removed: 2 })
  })

  it('只是近似：行挪了位置不算改动，重复的行按次数算', () => {
    expect(lineChanges('a\nb\nc', 'c\na\nb')).toEqual({ added: 0, removed: 0 })
    expect(lineChanges('a\na\nb', 'a\nb\nb')).toEqual({ added: 1, removed: 1 })
  })

  it('线性：两万行对两万行完全不同的正文也很快', () => {
    const before = Array.from({ length: 20_000 }, (_, i) => `a${i}`).join('\n')
    const after = Array.from({ length: 20_000 }, (_, i) => `b${i}`).join('\n')
    const start = performance.now()
    expect(lineChanges(before, after)).toEqual({ added: 20_000, removed: 20_000 })
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('认得的时区', () => {
  it('查询失败只让这一次失败，不把失败留给别的请求；查成功之后不再查', async () => {
    const failing = { execute: () => Promise.reject(new Error('连接断开')) }
    let calls = 0
    const working = {
      execute: async () => {
        calls++
        return [{ name: 'Asia/Shanghai' }, { name: 'UTC' }]
      },
    }
    await expect(knownTimeZone(failing, 'UTC')).rejects.toThrow('连接断开')
    expect(await knownTimeZone(working, 'Asia/Shanghai')).toBe(true)
    expect(await knownTimeZone(working, 'Mars/Base')).toBe(false)
    expect(await knownTimeZone(failing, 'UTC')).toBe(true)
    expect(calls).toBe(1)
  })
})
