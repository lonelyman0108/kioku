import { RUNTIME_FAMILIES, type RuntimeFamily } from '@kioku/contracts'

export const RUNTIME_NAMES: Record<RuntimeFamily, string> = {
  claudecode: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  agy: 'Antigravity',
  opencode: 'OpenCode',
  pi: 'Pi',
  dsh: 'DSH',
  zcode: 'ZCode',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  mcp: 'MCP 客户端',
  generic: '通用客户端',
}

export const RUNTIME_HINTS: Record<RuntimeFamily, string> = {
  claudecode: '命令钩子 · MCP',
  codex: '命令钩子 · MCP',
  gemini: '命令钩子 · MCP',
  agy: '命令钩子 · MCP',
  opencode: '进程扩展 · MCP',
  pi: '进程扩展 · MCP',
  dsh: 'Cordis 插件 · MCP',
  zcode: '命令钩子 · MCP',
  openclaw: '记忆插件 · 工具转发',
  hermes: '内存 Provider · 工具转发',
  mcp: '仅标准 MCP 工具',
  generic: '自定义客户端接入',
}

export function runtimeName(family: string): string {
  return Object.hasOwn(RUNTIME_NAMES, family) ? RUNTIME_NAMES[family as RuntimeFamily] : family
}

export function runtimeHint(family: string): string {
  return Object.hasOwn(RUNTIME_HINTS, family) ? RUNTIME_HINTS[family as RuntimeFamily] : ''
}

export const RUNTIME_OPTIONS = RUNTIME_FAMILIES.map((value) => ({
  value,
  label: RUNTIME_NAMES[value],
  hint: RUNTIME_HINTS[value],
}))
