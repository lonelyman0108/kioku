import type { BenchScenarioInput, BenchStep } from '@kioku/contracts'
import type { z } from 'zod'

import { BENCH_GROUP_CONTEXT, EXPIRES, runTitle } from './shared'

const PROBE_TITLE = runTitle('权限探测词条')
const PROBE_SECRET_TITLE = runTitle('权限探测机密')

const tool = (label: string, name: string, args: Record<string, unknown> = {}) =>
  ({ kind: 'tool', label, tool: name, arguments: args }) satisfies z.input<typeof BenchStep>

// 权限探测：每把 Key 的正确结果都不同，所以只列结果，不带断言，也不声明 requires。
// 想知道「这把 Key 接到群里读得到什么」看带群聊上下文的那两步，不要看工具：工具调用按 Key 的全部权限读写
export const permissionProbe: BenchScenarioInput = {
  id: 'permission-probe',
  title: '权限探测',
  description:
    '列出当前访问密钥不带上下文、带群聊与定时任务上下文时读写的结果，不判通过与失败。会话上下文只作用于生命周期事件与 /recall，工具调用不带，真实的 MCP 也不带。写的那几步写完即删。',
  probe: true,
  steps: [
    { kind: 'whoami', label: '当前访问密钥的上限' },
    { kind: 'boot', label: '启动加载' },
    tool('启动基线（工具）', 'kioku_boot'),
    tool('按主题浏览词条', 'kioku_browse', { group_by: 'topic' }),
    tool('按短 ID 读 m-234567', 'kioku_get', { id: 'm-234567' }),
    tool('搜索', 'kioku_search', { query: '测试台的权限探测', cross_circle: true }),
    tool('列凭据', 'kioku_credential'),
    { kind: 'recall', label: '不带上下文的召回', body: { query: '测试台的权限探测' } },
    {
      kind: 'recall',
      label: '群聊上下文的召回',
      body: { query: '测试台的权限探测', context: BENCH_GROUP_CONTEXT },
    },
    {
      kind: 'lifecycle',
      label: '群聊上下文的每轮输入',
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
    tool('写普通词条', 'kioku_create', {
      title: PROBE_TITLE,
      content: '测试台的权限探测写下的，运行标记 ${run}。',
      sensitivity: 'private',
      priority: 2,
      valid_to: EXPIRES,
    }),
    tool('写机密词条', 'kioku_create', {
      title: PROBE_SECRET_TITLE,
      content: '测试台的权限探测写下的 secret 正文，不是真的内容。',
      sensitivity: 'secret',
      valid_to: EXPIRES,
    }),
    tool('删掉普通词条', 'kioku_delete', { id: PROBE_TITLE }),
    tool('删掉机密词条', 'kioku_delete', { id: PROBE_SECRET_TITLE }),
  ],
}
