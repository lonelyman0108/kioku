import type { BenchScenarioInput } from '@kioku/contracts'

import {
  BENCH_DEVICE_KEY,
  BENCH_PROJECT,
  ENTRY_WRITE,
  EXPIRES,
  GUIDANCE_START,
  runTitle,
} from './shared'

const KEYWORD = 'bench${run}'
const SESSION_ID = 'bench-${run}'

// Claude Code / Codex 一次会话：会话开始注入、每轮召回，模型用短 ID 读写词条。生命周期事件不带会话上下文，带固定设备与项目标识
export const claudeCodeSession: BenchScenarioInput = {
  id: 'claude-code-session',
  title: 'Claude Code 一次会话',
  description:
    '会话开始时注入启动加载的内容，每轮输入召回，模型用工具读写词条并验证短 ID，最后删掉写下的。',
  runtimes: ['claudecode', 'codex'],
  steps: [
    {
      kind: 'lifecycle',
      label: '会话开始',
      body: {
        event: 'session.start',
        sessionId: SESSION_ID,
        deviceKey: BENCH_DEVICE_KEY,
        project: BENCH_PROJECT,
      },
      expect: { error: false, contains: [GUIDANCE_START] },
    },
    {
      kind: 'lifecycle',
      label: '每轮输入的召回',
      body: {
        event: 'prompt.submit',
        sessionId: SESSION_ID,
        deviceKey: BENCH_DEVICE_KEY,
        project: BENCH_PROJECT,
        prompt: '这个项目的约定是什么？',
      },
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '记下一条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('会话词条'),
        content: '测试台写下的记忆，运行标记 ${run}。',
        sensitivity: 'private',
        priority: 2,
        disclosure: '测试台的 Claude Code 会话场景',
        glossary: [KEYWORD],
        valid_to: EXPIRES,
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['版本: 1'] },
      capture: { id: 'ID: ', version: '版本: ' },
    },
    {
      kind: 'lifecycle',
      label: '下一轮召回得到它',
      body: { event: 'prompt.submit', sessionId: SESSION_ID, prompt: `回忆一下 ${KEYWORD} 这条` },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${id}'] },
    },
    {
      kind: 'tool',
      label: '读正文',
      tool: 'kioku_get',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['运行标记 ${run}', 'Disclosure: '] },
    },
    {
      kind: 'tool',
      label: '改它',
      tool: 'kioku_update',
      arguments: { id: '${id}', priority: 3, expected_version: '${version}' },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['priority: 3', '版本: 2'] },
    },
    {
      kind: 'tool',
      label: '搜得到',
      tool: 'kioku_search',
      arguments: { query: KEYWORD },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${id}'] },
    },
    {
      kind: 'tool',
      label: '删掉',
      tool: 'kioku_delete',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
  ],
}
