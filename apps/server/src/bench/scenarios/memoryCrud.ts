import type { BenchScenarioInput } from '@kioku/contracts'

import { ENTRY_WRITE, EXPIRES, GUIDANCE_START, SECRET_WRITE, runTitle } from './shared'

const KEYWORD = 'bench${run}'
const SEALED_TITLE = runTitle('测试机密')

// 词条增删改查，所有运行时都适用。secret 那几步只断言报错与否和元数据
export const memoryCrud: BenchScenarioInput = {
  id: 'memory-crud',
  title: '词条增删改查',
  description:
    '新建、读取、修改、浏览、搜索、删除一条正式词条；机密级的访问密钥再走一遍新建与读取。',
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
        title: runTitle('测试词条'),
        content: '测试台写下的记忆，运行标记 ${run}。',
        sensitivity: 'private',
        topics: ['bench'],
        priority: 2,
        disclosure: '测试台的增删改查场景',
        glossary: [KEYWORD],
        valid_to: EXPIRES,
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['敏感级: private', '版本: 1'] },
      capture: { id: 'ID: ', version: '版本: ' },
    },
    {
      kind: 'tool',
      label: '读取',
      tool: 'kioku_get',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['运行标记 ${run}'] },
    },
    {
      kind: 'tool',
      label: '修改',
      tool: 'kioku_update',
      arguments: {
        id: '${id}',
        content: '测试台改过的记忆，运行标记 ${run}。',
        priority: 3,
        expected_version: '${version}',
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['改过的记忆', 'priority: 3', '版本: 2'] },
      capture: { version: '版本: ' },
    },
    {
      kind: 'tool',
      label: '版本号不对时报错',
      tool: 'kioku_update',
      arguments: { id: '${id}', priority: 4, expected_version: 999 },
      requires: ENTRY_WRITE,
      expect: { error: true, contains: ['重新读取'] },
    },
    {
      kind: 'tool',
      label: '按主题浏览',
      tool: 'kioku_browse',
      arguments: { group_by: 'topic', topic: 'bench' },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${id}'] },
    },
    {
      kind: 'tool',
      label: '搜索',
      tool: 'kioku_search',
      arguments: { query: KEYWORD },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${id}'] },
    },
    {
      kind: 'tool',
      label: '删除',
      tool: 'kioku_delete',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
    {
      kind: 'tool',
      label: '删掉之后读不到',
      tool: 'kioku_get',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: true, contains: ['未找到词条'] },
    },
    {
      kind: 'tool',
      label: '新建机密记忆',
      tool: 'kioku_create',
      arguments: {
        title: SEALED_TITLE,
        content: '测试台写下的 secret 正文，不是真的内容。',
        sensitivity: 'secret',
        valid_to: EXPIRES,
      },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['敏感级: secret'] },
      capture: { secretId: 'ID: ' },
    },
    {
      kind: 'tool',
      label: '读机密记忆的元数据',
      tool: 'kioku_get',
      arguments: { id: '${secretId}' },
      requires: SECRET_WRITE,
      expect: { error: false, contains: ['敏感级: secret'] },
    },
    {
      kind: 'tool',
      label: '删掉机密记忆',
      tool: 'kioku_delete',
      arguments: { id: '${secretId}' },
      requires: SECRET_WRITE,
      expect: { error: false },
    },
  ],
}
