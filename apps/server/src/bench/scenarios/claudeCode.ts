import type { BenchScenarioInput } from '@kioku/contracts'

import { GUIDANCE_START, PRIVATE_WRITE, runUri } from './shared'

const NOTE = runUri('note')
const KEYWORD = 'bench${run}'
const SESSION_ID = 'bench-${run}'

// Claude Code 一次会话：会话开始注入、每轮召回，模型读写记忆。生命周期事件不带会话上下文，和钩子一样
export const claudeCodeSession: BenchScenarioInput = {
  id: 'claude-code-session',
  title: 'Claude Code 一次会话',
  description: '会话开始注入启动上下文，每轮输入召回，模型用工具读写记忆，最后删掉写下的。',
  runtimes: ['claudecode', 'codex'],
  steps: [
    {
      kind: 'lifecycle',
      label: '会话开始',
      body: {
        event: 'session.start',
        sessionId: SESSION_ID,
        project: { dirName: 'bench-${run}' },
      },
      expect: { error: false, contains: [GUIDANCE_START] },
    },
    {
      kind: 'lifecycle',
      label: '每轮输入的召回',
      body: { event: 'prompt.submit', sessionId: SESSION_ID, prompt: '这个项目的约定是什么？' },
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '记下一条',
      tool: 'kioku_create',
      arguments: {
        uri: NOTE,
        content: '测试台写下的记忆，运行标记 ${run}。',
        layer: 'private',
        priority: 2,
        disclosure: '测试台的 Claude Code 会话场景',
        glossary: [KEYWORD],
      },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: [`URI: ${NOTE}`, '版本: 1'] },
      capture: { version: '版本: ' },
    },
    {
      kind: 'lifecycle',
      label: '下一轮召回得到它',
      body: { event: 'prompt.submit', sessionId: SESSION_ID, prompt: `回忆一下 ${KEYWORD} 这条` },
      requires: PRIVATE_WRITE,
      expect: { error: false, uris: [NOTE] },
    },
    {
      kind: 'tool',
      label: '读正文',
      tool: 'kioku_get',
      arguments: { uri: NOTE },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: ['运行标记 ${run}', 'Disclosure: '] },
    },
    {
      kind: 'tool',
      label: '改它',
      tool: 'kioku_update',
      arguments: { uri: NOTE, priority: 3, expected_version: '${version}' },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: ['priority: 3', '版本: 2'] },
    },
    {
      kind: 'tool',
      label: '搜得到',
      tool: 'kioku_search',
      arguments: { query: KEYWORD },
      requires: PRIVATE_WRITE,
      expect: { error: false, uris: [NOTE] },
    },
    {
      kind: 'tool',
      label: '删掉',
      tool: 'kioku_delete',
      arguments: { uri: NOTE },
      requires: PRIVATE_WRITE,
      expect: { error: false },
    },
  ],
}
