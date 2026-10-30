import type { BenchScenarioInput, BenchStep } from '@kioku/contracts'
import type { z } from 'zod'

import { BENCH_GROUP_CONTEXT, runUri } from './shared'

const PROBE = runUri('probe')
const PROBE_SECRET = runUri('probe-secret')
const GROUP_LABEL = '（会话上下文只作用于生命周期事件与 /recall，工具调用不带，真实的 MCP 也不带）'

const tool = (label: string, name: string, args: Record<string, unknown> = {}) =>
  ({ kind: 'tool', label, tool: name, arguments: args }) satisfies z.input<typeof BenchStep>

// 权限探测：每把 Key 的正确结果都不同，所以只列结果，不带断言，也不声明 requires。
// 想知道「这把 Key 接到群里读得到什么」看带群聊上下文的那两步，不要看工具：工具调用按 Key 的全部权限读写
export const permissionProbe: BenchScenarioInput = {
  id: 'permission-probe',
  title: '权限探测',
  description:
    '列出这把 Key 不带上下文、带群聊与定时任务上下文时读写的结果，不判通过与失败。写的那几步只写私人层，最后删掉。',
  probe: true,
  steps: [
    { kind: 'whoami', label: 'Key 的上限' },
    { kind: 'boot', label: '启动节点' },
    tool('启动基线（工具）', 'kioku_boot'),
    tool('记忆树', 'kioku_list'),
    tool('按 URI 读 core://agent', 'kioku_get', { uri: 'core://agent' }),
    tool('搜索', 'kioku_search', { query: '测试台的权限探测' }),
    tool('列凭据', 'kioku_credential'),
    { kind: 'recall', label: '不带上下文的召回', body: { query: '测试台的权限探测' } },
    {
      kind: 'recall',
      label: `群聊上下文的召回${GROUP_LABEL}`,
      body: { query: '测试台的权限探测', context: BENCH_GROUP_CONTEXT },
    },
    {
      kind: 'lifecycle',
      label: `群聊上下文的每轮输入${GROUP_LABEL}`,
      body: {
        event: 'prompt.submit',
        prompt: '测试台的权限探测',
        context: BENCH_GROUP_CONTEXT,
      },
    },
    {
      kind: 'recall',
      label: '定时任务上下文的召回',
      body: { query: '测试台的权限探测', context: { chatType: 'cron' } },
    },
    tool('写私人层', 'kioku_create', {
      uri: PROBE,
      content: '测试台的权限探测写下的，运行标记 ${run}。',
      layer: 'private',
      priority: 2,
    }),
    tool('写 secret 级', 'kioku_create', {
      uri: PROBE_SECRET,
      content: '测试台的权限探测写下的 secret 正文，不是真的内容。',
      layer: 'private',
      sensitivity: 'secret',
    }),
    tool('删掉写私人层的那条', 'kioku_delete', { uri: PROBE }),
    tool('删掉写 secret 级的那条', 'kioku_delete', { uri: PROBE_SECRET }),
  ],
}
