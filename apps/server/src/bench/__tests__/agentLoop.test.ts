import { RUNTIME_FAMILIES, type BenchAgentLoop, type RuntimeFamily } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { CHAT_FAMILIES } from '../../lifecycle/lifecycle'
import { agentGetsTools, agentLoopFor } from '../agentLoop'

// 写成穷举：新加运行时的时候要在这里想一下它走哪种循环
const EXPECTED: Record<RuntimeFamily, BenchAgentLoop> = {
  claudecode: 'hook',
  codex: 'hook',
  astrbot: 'chat',
  mcp: 'tools',
  openclaw: 'approximate',
  hermes: 'approximate',
  opencode: 'approximate',
  pi: 'approximate',
  other: 'approximate',
}

describe('模型循环按运行时分', () => {
  it.each(RUNTIME_FAMILIES)('%s', (family) => {
    expect(agentLoopFor(family)).toBe(EXPECTED[family])
    expect(agentGetsTools(agentLoopFor(family))).toBe(EXPECTED[family] !== 'chat')
  })

  it('聊天类和生命周期事件用的是同一份名单', () => {
    for (const family of RUNTIME_FAMILIES) {
      expect(agentLoopFor(family) === 'chat', family).toBe(CHAT_FAMILIES.has(family))
    }
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', ''])(
    '不认识的运行时按近似：%s',
    (family) => {
      expect(agentLoopFor(family)).toBe('approximate')
    },
  )
})
