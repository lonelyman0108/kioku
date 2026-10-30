import type { BenchAgentLoop } from '@kioku/contracts'

import { CHAT_FAMILIES } from '../lifecycle/lifecycle'

// 模型循环按运行时分几种，和真实接入一致，每种要做什么见 contracts 的 BENCH_AGENT_LOOPS。
// 聊天类不在这张表里，以 CHAT_FAMILIES 为准
const LOOPS: ReadonlyMap<string, BenchAgentLoop> = new Map([
  ['claudecode', 'hook'],
  ['codex', 'hook'],
  ['mcp', 'tools'],
])

export function agentLoopFor(runtimeFamily: string): BenchAgentLoop {
  if (CHAT_FAMILIES.has(runtimeFamily)) return 'chat'
  return LOOPS.get(runtimeFamily) ?? 'approximate'
}

// 真实的聊天类宿主不能调记忆工具，这里也不给模型
export const agentGetsTools = (loop: BenchAgentLoop) => loop !== 'chat'
