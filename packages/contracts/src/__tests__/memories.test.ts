import { describe, expect, it } from 'vitest'

import {
  MemoryTitle,
  MemoryUri,
  URI_FORMAT_MESSAGE,
  URI_PATTERN,
  URI_PREFIX_PATTERN,
} from '../memories'
import { CURATED_LAYERS } from '../memory'

describe('坐标', () => {
  it('只认四种开头，人格与应用的开头之后至少还有一段', () => {
    for (const uri of [
      'core://agent',
      'user://preferences/reply_style',
      'user://projects/kioku/deploy-steps',
      'persona://default/soul',
      'app://claudecode/agent',
      'app://claudecode/rules/commit',
    ]) {
      expect(URI_PATTERN.test(uri), uri).toBe(true)
    }
    for (const uri of [
      // 旧的写法：分区不再是开头
      'preferences://user',
      'base://agent',
      'private://notes',
      // 人格、应用只有标识，没有记忆的标识
      'persona://default',
      'app://claudecode',
      'core://',
      'core://Agent',
      'core://a b',
      'core://a//b',
      'core://a/',
      'Core://agent',
      'episode://x',
      'subject://x',
    ]) {
      expect(URI_PATTERN.test(uri), uri).toBe(false)
    }
  })

  it('开头之后最多 16 段、每段最长 64 个字符，人格与应用的标识也算一段', () => {
    const segments = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join('/')
    expect(URI_PATTERN.test(`core://${segments(16)}`)).toBe(true)
    expect(URI_PATTERN.test(`core://${segments(17)}`)).toBe(false)
    expect(URI_PATTERN.test(`persona://default/${segments(15)}`)).toBe(true)
    expect(URI_PATTERN.test(`persona://default/${segments(16)}`)).toBe(false)
    expect(URI_PATTERN.test(`user://${'a'.repeat(64)}`)).toBe(true)
    expect(URI_PATTERN.test(`user://${'a'.repeat(65)}`)).toBe(false)
  })

  it('第一组是开头、第二组是开头之后的整段，开头就是归属', () => {
    const match = URI_PATTERN.exec('persona://default/soul')
    expect(match?.[1]).toBe('persona')
    expect(match?.[2]).toBe('default/soul')
    for (const layer of CURATED_LAYERS) {
      const uri = layer === 'persona' || layer === 'app' ? `${layer}://x/y` : `${layer}://y`
      expect(URI_PATTERN.exec(uri)?.[1]).toBe(layer)
    }
  })

  it('格式不对时的说明写出四种开头各放什么', () => {
    const result = MemoryUri.safeParse('preferences://user')
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe(URI_FORMAT_MESSAGE)
    for (const root of ['core://', 'user://', 'persona://<人格标识>/', 'app://<应用标识>/']) {
      expect(URI_FORMAT_MESSAGE).toContain(root)
    }
  })
})

describe('坐标前缀', () => {
  it('四种开头之一，后面至少一段；人格、应用只有标识也算', () => {
    for (const prefix of [
      'user://projects',
      'persona://default',
      'app://claudecode',
      'core://a/b',
    ]) {
      expect(URI_PREFIX_PATTERN.test(prefix), prefix).toBe(true)
    }
    for (const prefix of ['user://', 'user', 'projects://x', 'core://a/', 'core://A']) {
      expect(URI_PREFIX_PATTERN.test(prefix), prefix).toBe(false)
    }
  })
})

describe('标题', () => {
  it('去掉首尾空白之后 1–80 个字符', () => {
    expect(MemoryTitle.parse('  部署步骤  ')).toBe('部署步骤')
    expect(MemoryTitle.safeParse('   ').success).toBe(false)
    expect(MemoryTitle.safeParse('').success).toBe(false)
    expect(MemoryTitle.safeParse('标'.repeat(80)).success).toBe(true)
    expect(MemoryTitle.safeParse('标'.repeat(81)).success).toBe(false)
  })

  it('不含控制字符，换行与制表符也不行', () => {
    for (const title of ['第一行\n第二行', '名称\t说明', '响铃\u0007', '\u0085下一行']) {
      expect(MemoryTitle.safeParse(title).success, JSON.stringify(title)).toBe(false)
    }
    expect(MemoryTitle.safeParse('回答用中文 · 先给结论（简洁）').success).toBe(true)
  })
})
