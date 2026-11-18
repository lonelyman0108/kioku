import type { BenchScenarioInput } from '@kioku/contracts'

import { ENTRY_WRITE, EXPIRES, runTitle } from './shared'

const KEYWORD = 'link${run}'
const TARGET_TITLE = runTitle('被双链目标')

// 双链 1 跳语境扩散：A 引用 [[B]]，读取 A 时自动注上 B 的最新标题，按 A 的关键词召回时 1 跳扩散出 B
export const linksAndRecall: BenchScenarioInput = {
  id: 'links-and-recall',
  title: '双链解析与 1 跳扩散',
  description: '新建被引用词条与带 [[m-xxxxxx]] 双链的主词条，验证实时注标题、1 跳召回扩散并清理。',
  steps: [
    {
      kind: 'tool',
      label: '新建目标词条',
      tool: 'kioku_create',
      arguments: {
        title: TARGET_TITLE,
        content: '被链接目标的正文，运行标记 ${run}。',
        sensitivity: 'private',
        topics: ['bench'],
        priority: 2,
        valid_to: EXPIRES,
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['版本: 1'] },
      capture: { targetId: 'ID: ' },
    },
    {
      kind: 'tool',
      label: '新建带双链的主词条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('带双链主词条'),
        content: `先参考 [[$\{targetId}]] 的约定，关键词 ${KEYWORD}。`,
        sensitivity: 'private',
        topics: ['bench'],
        priority: 1,
        glossary: [KEYWORD],
        valid_to: EXPIRES,
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['关联词条', '[[${targetId}|'] },
      capture: { seedId: 'ID: ' },
    },
    {
      kind: 'tool',
      label: '读取主词条自动注上标题',
      tool: 'kioku_get',
      arguments: { id: '${seedId}' },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: [`[[$\{targetId}|${TARGET_TITLE}]]`, '关联词条'] },
    },
    {
      kind: 'recall',
      label: '召回 1 跳扩散出目标词条',
      body: { query: KEYWORD },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${seedId}', '${targetId}'] },
    },
    {
      kind: 'tool',
      label: '删掉主词条',
      tool: 'kioku_delete',
      arguments: { id: '${seedId}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉目标词条',
      tool: 'kioku_delete',
      arguments: { id: '${targetId}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
  ],
}
