import type { BenchScenarioInput } from '@kioku/contracts'

import {
  BENCH_GROUP_CONTEXT,
  ENTRY_WRITE,
  EXPIRES,
  PUBLIC_WRITE,
  SECRET_WRITE,
  runTitle,
} from './shared'

const KEYWORD = 'cap${run}'

// 敏感级与会话封顶：同关键词下公开/私有/机密三档词条，群聊上下文强制封顶到 public，机密词条不进召回
export const contextIsolation: BenchScenarioInput = {
  id: 'context-cap-and-isolation',
  title: '敏感级封顶与秘密隔离',
  description:
    '验证无上下文召回与群聊上下文的敏感级硬封顶（public 可见、private 拦截），以及 secret 不进入召回。',
  steps: [
    {
      kind: 'tool',
      label: '新建公开词条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('公开词条'),
        content: `任何场合都可见的公开规则，${KEYWORD}。`,
        sensitivity: 'public',
        glossary: [KEYWORD],
        valid_to: EXPIRES,
      },
      requires: PUBLIC_WRITE,
      expect: { error: false, contains: ['敏感级: public'] },
      capture: { pubId: 'ID: ' },
    },
    {
      kind: 'tool',
      label: '新建私密词条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('私有词条'),
        content: `仅本机无上下文可见，${KEYWORD}。`,
        sensitivity: 'private',
        glossary: [KEYWORD],
        valid_to: EXPIRES,
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['敏感级: private'] },
      capture: { privId: 'ID: ' },
    },
    {
      kind: 'recall',
      label: '无上下文召回可见公开与私有',
      body: { query: KEYWORD },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${pubId}', '${privId}'] },
    },
    {
      kind: 'recall',
      label: '群聊上下文封顶到公开',
      body: { query: KEYWORD, context: BENCH_GROUP_CONTEXT },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${pubId}'], notShortIds: ['${privId}'] },
    },
    {
      kind: 'tool',
      label: '新建机密词条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('机密词条'),
        content: `机密正文不会进召回，${KEYWORD}。`,
        sensitivity: 'secret',
        valid_to: EXPIRES,
      },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['敏感级: secret'] },
      capture: { secId: 'ID: ' },
    },
    {
      kind: 'recall',
      label: '机密词条不进入召回',
      body: { query: KEYWORD },
      requires: SECRET_WRITE,
      expect: { error: false, notShortIds: ['${secId}'] },
    },
    {
      kind: 'tool',
      label: '删掉机密词条',
      tool: 'kioku_delete',
      arguments: { id: '${secId}' },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉私有词条',
      tool: 'kioku_delete',
      arguments: { id: '${privId}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉公开词条',
      tool: 'kioku_delete',
      arguments: { id: '${pubId}' },
      requires: PUBLIC_WRITE,
      expect: { error: false },
    },
  ],
}
