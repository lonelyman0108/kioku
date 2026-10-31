import { LORE_BACKUP_FORMAT } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { MemoryError } from '../../memory/service'
import { planImport } from '../lore'
import { parseLoreBackup } from '../loreBackup'

const at = '2026-01-01T00:00:00.000Z'
// 和真实导出相同的形状：edges.id 是字符串，paths.edge_id 是数字，多余的列也在
const backup = (overrides: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  format: LORE_BACKUP_FORMAT,
  created_at: at,
  ...top,
  tables: {
    nodes: [{ uuid: 'n1', created_at: at }],
    memories: [
      {
        id: '5',
        node_uuid: 'n1',
        content: '正文',
        deprecated: false,
        migrated_to: null,
        created_at: at,
      },
    ],
    edges: [
      {
        id: '7',
        parent_uuid: 'root',
        child_uuid: 'n1',
        priority: 1,
        disclosure: '什么时候',
        created_at: at,
      },
    ],
    paths: [{ domain: 'infra', path: 'nas', edge_id: 7, created_at: at }],
    glossary_keywords: [{ id: '1', keyword: '存储', node_uuid: 'n1', created_at: at }],
    ...overrides,
  },
})

const rejected = (input: unknown): string => {
  try {
    parseLoreBackup(input)
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryError)
    expect((err as MemoryError).status).toBe(400)
    return (err as MemoryError).message
  }
  throw new Error('没有拒绝')
}

describe('解析 Lore 的导出', () => {
  it('转成和读库相同的节点；id 不论字符串还是数字都连得上', () => {
    const { snapshot, exportedAt } = parseLoreBackup(backup())
    expect(exportedAt).toBe(at)
    expect(snapshot.recallEvents).toBeNull()
    expect(snapshot.nodes).toEqual([
      {
        uuid: 'n1',
        uri: 'infra://nas',
        aliases: [],
        priority: 1,
        disclosure: '什么时候',
        content: '正文',
        createdAt: new Date(at),
        updatedAt: new Date(at),
        previousVersions: 0,
        keywords: ['存储'],
      },
    ])
    const numeric = parseLoreBackup(
      backup({
        edges: [{ id: 7, child_uuid: 'n1', priority: 1, disclosure: null }],
        paths: [{ domain: 'infra', path: 'nas', edge_id: '7', created_at: at }],
      }),
    )
    expect(numeric.snapshot.nodes.map((n) => n.uri)).toEqual(['infra://nas'])
  })

  it('不管列的多余与类型：migrated_to 是数字或文字都接受，只看用到的列', () => {
    const { snapshot } = parseLoreBackup(
      backup({
        memories: [
          { id: 5, node_uuid: 'n1', content: '正文', deprecated: false, created_at: at },
          { node_uuid: 'n1', deprecated: true, migrated_to: 12 },
          { node_uuid: 'n1', deprecated: true, migrated_to: 'x', content: '旧版本' },
        ],
      }),
    )
    expect(snapshot.nodes[0]).toMatchObject({ content: '正文', previousVersions: 2 })
  })

  it('当前版本取最新的一条，时间相同时按 id 的数值，不按字符串', () => {
    const row = (id: string, content: string, created = at) => ({
      id,
      node_uuid: 'n1',
      content,
      deprecated: false,
      created_at: created,
    })
    const pick = (memories: unknown[]) =>
      parseLoreBackup(backup({ memories })).snapshot.nodes[0]!.content
    expect(pick([row('9', '九'), row('10', '十')])).toBe('十')
    expect(pick([row('10', '十'), row('9', '九', '2026-01-01T00:00:01.000Z')])).toBe('九')
  })

  it('引用缺失的路径与边跳过，不报错：和读库的内连接一样', () => {
    const { snapshot } = parseLoreBackup(
      backup({
        paths: [
          { domain: 'infra', path: 'nas', edge_id: 7, created_at: at },
          { domain: 'infra', path: 'no_edge', edge_id: 99, created_at: at },
          { domain: 'infra', path: 'no_node', edge_id: 8, created_at: at },
        ],
        edges: [
          { id: '7', child_uuid: 'n1', priority: 1, disclosure: null },
          { id: '8', child_uuid: 'missing', priority: 1, disclosure: null },
        ],
      }),
    )
    expect(snapshot.nodes.map((n) => n.uri)).toEqual(['infra://nas'])
  })

  it('打乱行序结果不变：路径按时间、domain、path 排，先到的是主路径', () => {
    const paths = [
      { domain: 'infra', path: 'b', edge_id: 7, created_at: '2026-01-01T00:00:00.002Z' },
      { domain: 'infra', path: 'a', edge_id: 7, created_at: '2026-01-01T00:00:00.002Z' },
      { domain: 'zzz', path: 'first', edge_id: 7, created_at: '2026-01-01T00:00:00.001Z' },
    ]
    const nodes = (rows: typeof paths) =>
      parseLoreBackup(backup({ paths: rows })).snapshot.nodes.map((n) => [n.uri, n.aliases])
    expect(nodes(paths)).toEqual([['zzz://first', ['infra://a', 'infra://b']]])
    expect(nodes([...paths].reverse())).toEqual(nodes(paths))
  })

  it('业务范围留给计划：priority 超范围只跳过这一个节点，不拒绝整个文件', () => {
    const { snapshot } = parseLoreBackup(
      backup({ edges: [{ id: '7', child_uuid: 'n1', priority: 500, disclosure: null }] }),
    )
    const plan = planImport(snapshot, [], {
      accountId: 'me',
      persona: { slug: 'default', name: '默认人格' },
      secretUris: new Set(),
    })
    expect(plan.memories).toEqual([])
    expect(plan.skipped.map((s) => s.source)).toEqual(['infra://nas'])
  })

  it('不是 Lore 的导出直接拒绝', () => {
    for (const input of [null, 'x', [], {}, backup({}, { format: 'other' })]) {
      expect(rejected(input)).toBe('不是 Lore 的导出文件')
    }
  })

  it('五张表都必填：少了关键词的表不能当成没有关键词，同步会把关键词都删掉', () => {
    for (const table of ['nodes', 'memories', 'edges', 'paths', 'glossary_keywords']) {
      expect(rejected(backup({ [table]: undefined }))).toContain(`tables.${table}：缺少这张表`)
      expect(rejected(backup({ [table]: {} }))).toContain(`tables.${table}：缺少这张表`)
    }
    expect(rejected({ format: LORE_BACKUP_FORMAT, created_at: at })).toContain('缺少 tables')
  })

  it('一张表的行数有上限', () => {
    expect(rejected(backup({ glossary_keywords: new Array(200_001).fill({}) }))).toContain(
      '超过 200000 行',
    )
  })

  it('字段不对时点出第几行、哪个字段，不带内容', () => {
    const live = { id: '5', node_uuid: 'n1', deprecated: false, created_at: at }
    expect(rejected(backup({ memories: [live] }))).toContain('memories 第 1 行 content')
    expect(rejected(backup({ memories: [{ ...live, content: 12 }] }))).toContain(
      'memories 第 1 行 content',
    )
    expect(
      rejected(backup({ glossary_keywords: [{ keyword: 12, node_uuid: 'n1', created_at: at }] })),
    ).toContain('glossary_keywords 第 1 行 keyword')
    expect(
      rejected(backup({ edges: [{ id: 'abc', child_uuid: 'n1', priority: 1, disclosure: null }] })),
    ).toContain('edges 第 1 行 id')
    expect(
      rejected(backup({ edges: [{ id: '7', child_uuid: 'n1', priority: 1.5, disclosure: null }] })),
    ).toContain('edges 第 1 行 priority')
  })

  it('存不进数据库的字符（NUL、落单的代理项）拒绝，报错里没有内容', () => {
    const bad = (text: string) => [
      backup({
        memories: [{ id: '5', node_uuid: 'n1', content: text, deprecated: false, created_at: at }],
      }),
      backup({ edges: [{ id: '7', child_uuid: 'n1', priority: 1, disclosure: text }] }),
      backup({ paths: [{ domain: 'infra', path: text, edge_id: 7, created_at: at }] }),
      backup({ glossary_keywords: [{ keyword: text, node_uuid: 'n1' }] }),
    ]
    for (const input of [...bad('机密a\u0000b'), ...bad('机密a\ud800b')]) {
      const message = rejected(input)
      expect(message).toContain('无法存入数据库')
      expect(message).not.toContain('机密')
    }
  })

  it('时间要合法、不能在未来；差一点的时钟不算', () => {
    const future = '9999-01-01T00:00:00.000Z'
    expect(rejected(backup({}, { created_at: future }))).toContain('created_at：时间在未来')
    expect(rejected(backup({ nodes: [{ uuid: 'n1', created_at: future }] }))).toContain(
      'nodes 第 1 行 created_at：时间在未来',
    )
    expect(
      rejected(
        backup({
          memories: [
            { id: '5', node_uuid: 'n1', content: 'x', deprecated: false, created_at: future },
          ],
        }),
      ),
    ).toContain('时间在未来')
    expect(
      rejected(backup({ paths: [{ domain: 'a', path: 'b', edge_id: 7, created_at: future }] })),
    ).toContain('时间在未来')
    for (const value of ['不是时间', '2026-13-40T00:00:00Z', '0000-01-01T00:00:00Z', 12]) {
      expect(rejected(backup({}, { created_at: value }))).toContain('created_at')
    }
    const soon = new Date(Date.now() + 3600_000).toISOString()
    expect(parseLoreBackup(backup({}, { created_at: soon })).exportedAt).toBe(soon)
    const later = new Date(Date.now() + 2 * 24 * 3600_000).toISOString()
    expect(rejected(backup({}, { created_at: later }))).toContain('时间在未来')
  })

  it('重复的主键拒绝：数据库不可能给出', () => {
    const edge = { id: '7', child_uuid: 'n1', priority: 1, disclosure: null }
    expect(rejected(backup({ edges: [edge, { ...edge, id: 7 }] }))).toContain(
      'edges 第 2 行和前面的行重复',
    )
    const path = { domain: 'infra', path: 'nas', edge_id: 7, created_at: at }
    expect(rejected(backup({ paths: [path, path] }))).toContain('paths 第 2 行和前面的行重复')
    const node = { uuid: 'n1', created_at: at }
    expect(rejected(backup({ nodes: [node, node] }))).toContain('nodes 第 2 行和前面的行重复')
  })
})
