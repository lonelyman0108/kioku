import { RUNTIME_FAMILIES, RUNTIME_FAMILY_NAMES, type RuntimeFamily } from '@kioku/contracts'

// 运行时的展示名称与简短说明，新建应用和展示时共用
export const RUNTIME_HINTS: Record<RuntimeFamily, string> = {
  claudecode: '命令钩子 · MCP',
  codex: '命令钩子 · MCP',
  gemini: '命令钩子 · MCP',
  agy: '命令钩子 · MCP',
  openclaw: '记忆插件 · 工具转发',
  hermes: '内存 Provider · 工具转发',
  opencode: '进程扩展 · MCP',
  pi: '进程扩展 · MCP',
  dsh: 'Cordis 插件 · MCP',
  astrbot: '群聊与私聊机器人',
  mcp: '仅标准 MCP 工具',
  other: '自定义客户端接入',
}

export function runtimeName(family: string): string {
  return Object.hasOwn(RUNTIME_FAMILY_NAMES, family)
    ? RUNTIME_FAMILY_NAMES[family as RuntimeFamily]
    : family
}

export function runtimeHint(family: string): string {
  return Object.hasOwn(RUNTIME_HINTS, family) ? RUNTIME_HINTS[family as RuntimeFamily] : ''
}

export const RUNTIME_OPTIONS = RUNTIME_FAMILIES.map((value) => ({
  value,
  label: RUNTIME_FAMILY_NAMES[value],
  hint: RUNTIME_HINTS[value],
}))
