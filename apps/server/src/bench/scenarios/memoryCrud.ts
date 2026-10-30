import type { BenchScenarioInput } from '@kioku/contracts'

import { GUIDANCE_START, PRIVATE_WRITE, runUri, SECRET_WRITE } from './shared'

const NOTE = runUri('note')
const MOVED = runUri('moved')
const SEALED = runUri('sealed')
const KEYWORD = 'bench${run}'

// 记忆增删改查，所有运行时都适用。secret 那几步只断言报错与否和元数据
export const memoryCrud: BenchScenarioInput = {
  id: 'memory-crud',
  title: '记忆增删改查',
  description:
    '新建、读取、修改、浏览、移动、搜索、删除一条私人层的记忆；secret 级的 Key 再走一遍新建与读取。',
  steps: [
    {
      kind: 'tool',
      label: '读启动基线',
      tool: 'kioku_boot',
      expect: { error: false, contains: [GUIDANCE_START] },
    },
    {
      kind: 'tool',
      label: '新建',
      tool: 'kioku_create',
      arguments: {
        uri: NOTE,
        content: '测试台写下的记忆，运行标记 ${run}。',
        layer: 'private',
        priority: 2,
        disclosure: '测试台的增删改查场景',
        glossary: [KEYWORD],
      },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: [`URI: ${NOTE}`, '敏感级: private', '版本: 1'] },
      capture: { version: '版本: ' },
    },
    {
      kind: 'tool',
      label: '读取',
      tool: 'kioku_get',
      arguments: { uri: NOTE },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: ['运行标记 ${run}'] },
    },
    {
      kind: 'tool',
      label: '修改',
      tool: 'kioku_update',
      arguments: {
        uri: NOTE,
        content: '测试台改过的记忆，运行标记 ${run}。',
        priority: 3,
        expected_version: '${version}',
      },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: ['改过的记忆', 'priority: 3', '版本: 2'] },
    },
    {
      kind: 'tool',
      label: '版本号不对时报错',
      tool: 'kioku_update',
      arguments: { uri: NOTE, priority: 4, expected_version: 999 },
      requires: PRIVATE_WRITE,
      expect: { error: true, contains: ['版本已变化'] },
    },
    {
      kind: 'tool',
      label: '浏览父路径',
      tool: 'kioku_list',
      arguments: { of: 'projects://bench/${run}' },
      requires: PRIVATE_WRITE,
      expect: { error: false, uris: [NOTE] },
    },
    {
      kind: 'tool',
      label: '移动',
      tool: 'kioku_move',
      arguments: { from: NOTE, to: MOVED },
      requires: PRIVATE_WRITE,
      expect: { error: false, contains: [`URI: ${MOVED}`, '版本: 3'] },
    },
    {
      kind: 'tool',
      label: '搜索',
      tool: 'kioku_search',
      arguments: { query: KEYWORD },
      requires: PRIVATE_WRITE,
      expect: { error: false, uris: [MOVED], notUris: [NOTE] },
    },
    {
      kind: 'tool',
      label: '删除',
      tool: 'kioku_delete',
      arguments: { uri: MOVED },
      requires: PRIVATE_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉之后读不到',
      tool: 'kioku_get',
      arguments: { uri: MOVED },
      requires: PRIVATE_WRITE,
      expect: { error: true, contains: ['不存在'] },
    },
    {
      kind: 'tool',
      label: '新建 secret',
      tool: 'kioku_create',
      arguments: {
        uri: SEALED,
        content: '测试台写下的 secret 正文，不是真的内容。',
        layer: 'private',
        sensitivity: 'secret',
      },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['敏感级: secret'] },
    },
    {
      kind: 'tool',
      label: '读 secret 的元数据',
      tool: 'kioku_get',
      arguments: { uri: SEALED },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['敏感级: secret'] },
    },
    {
      kind: 'tool',
      label: '删掉 secret',
      tool: 'kioku_delete',
      arguments: { uri: SEALED },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
  ],
}
