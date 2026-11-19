import type { BenchScenarioInput } from '@kioku/contracts'

import { ENTRY_WRITE, EXPIRES, runTitle } from './shared'

const KEYWORD = 'facet${run}'

// 多机环境切面切换：一条词条挂通用、Mac、Win 多个切片，按切面筛选与增量增删切片
export const variantsAndFacets: BenchScenarioInput = {
  id: 'variants-and-facets',
  title: '多变体与切面切换',
  description:
    '一次写入多环境变体切片，按 env 切面分别读取、查看全量并增量增删切片，最后删除清理。',
  steps: [
    {
      kind: 'tool',
      label: '新建多变体词条',
      tool: 'kioku_create',
      arguments: {
        title: runTitle('多端切面规范'),
        sensitivity: 'private',
        topics: ['bench'],
        glossary: [KEYWORD],
        valid_to: EXPIRES,
        variants: [
          { when: {}, content: '通用约定 ${run}。', sort_order: 0 },
          { when: { env: ['mac'] }, content: 'Mac 终端约定 ${run}。', sort_order: 1 },
          { when: { env: ['win'] }, content: 'Windows 终端约定 ${run}。', sort_order: 2 },
        ],
      },
      requires: ENTRY_WRITE,
      expect: { error: false, contains: ['版本: 1', 'Mac 终端约定 ${run}'] },
      capture: { id: 'ID: ', version: '版本: ' },
    },
    {
      kind: 'tool',
      label: '按 Mac 切面读取',
      tool: 'kioku_get',
      arguments: { id: '${id}', variant_filter: { env: ['mac'] } },
      requires: ENTRY_WRITE,
      expect: {
        error: false,
        contains: ['Mac 终端约定 ${run}', '其余可用切片'],
        notContains: ['Windows 终端约定 ${run}'],
      },
    },
    {
      kind: 'tool',
      label: '读取全量切片',
      tool: 'kioku_get',
      arguments: { id: '${id}', all_variants: true },
      requires: ENTRY_WRITE,
      expect: {
        error: false,
        contains: ['通用约定 ${run}', 'Mac 终端约定 ${run}', 'Windows 终端约定 ${run}'],
      },
    },
    {
      kind: 'tool',
      label: '增量增删切片',
      tool: 'kioku_update',
      arguments: {
        id: '${id}',
        expected_version: '${version}',
        upsert_variants: [{ when: { env: ['linux'] }, content: 'Linux 终端约定 ${run}。' }],
        remove_variant_whens: [{ env: ['win'] }],
      },
      requires: ENTRY_WRITE,
      expect: {
        error: false,
        contains: ['版本: 2', 'Linux 终端约定 ${run}'],
        notContains: ['Windows 终端约定 ${run}'],
      },
    },
    {
      kind: 'tool',
      label: '带切面条件搜索',
      tool: 'kioku_search',
      arguments: { query: KEYWORD, facets: { env: ['mac'] } },
      requires: ENTRY_WRITE,
      expect: { error: false, shortIds: ['${id}'] },
    },
    {
      kind: 'tool',
      label: '删掉多变体词条',
      tool: 'kioku_delete',
      arguments: { id: '${id}' },
      requires: ENTRY_WRITE,
      expect: { error: false },
    },
  ],
}
