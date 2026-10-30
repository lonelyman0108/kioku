import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { testDatabaseUrl } from '../../testing/db'
import { exportLore, LORE_SCHEMA, withoutDeprecatedContent } from '../../testing/loreFixture'
import { readLore, type LoreSnapshot } from '../lore'
import { parseLoreBackup } from '../loreBackup'

// 导出文件与读库的一致性：导出按 Lore 的列在同一份数据上查询、经 JSON 往返得到，不手写
describe.skipIf(!testDatabaseUrl)('Lore 的导出与读库结果相同', () => {
  let lore: postgres.Sql

  beforeAll(async () => {
    const admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(LORE_SCHEMA)
    await admin.end()
    lore = postgres(testDatabaseUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: 'lore_fixture' },
    })

    const node = (uuid: string, created = '2025-01-01T00:00:00Z') =>
      lore`insert into nodes (uuid, created_at) values (${uuid}, ${created})`
    const version = (
      uuid: string,
      content: string | null,
      options: { deprecated?: boolean; at?: string; id?: number } = {},
    ) => lore`insert into memories (id, node_uuid, content, deprecated, created_at) values (
      ${options.id ?? lore`nextval('memories_id_seq')`}, ${uuid}, ${content},
      ${options.deprecated ?? false}, ${options.at ?? '2025-02-01T00:00:00Z'})`
    const edge = async (uuid: string, priority: number, disclosure: string | null) => {
      const [row] = await lore<{ id: number }[]>`
        insert into edges (parent_uuid, child_uuid, priority, disclosure)
        values ('root', ${uuid}, ${priority}, ${disclosure}) returning id`
      return row!.id
    }
    const path = (domain: string, path: string, edgeId: number, at = '2025-01-02T00:00:00Z') =>
      lore`insert into paths (domain, path, edge_id, created_at)
        values (${domain}, ${path}, ${edgeId}, ${at})`
    const keyword = (uuid: string, word: string) =>
      lore`insert into glossary_keywords (keyword, node_uuid) values (${word}, ${uuid})`

    // 普通节点：旧版本、乱序的关键词
    await node('plain')
    await version('plain', '第一版', { deprecated: true })
    await version('plain', '第二版', { deprecated: true })
    await version('plain', '现在的正文')
    await path('infra', 'plain', await edge('plain', 1, '排查时'))
    for (const word of ['中文关键词', 'zzz', 'AAA']) await keyword('plain', word)

    // 别名：不同毫秒的两条路径，插入顺序和时间相反，两条边的 priority 与 disclosure 不同
    await node('aliased')
    await version('aliased', '有别名的正文')
    await path('b', 'later', await edge('aliased', 5, '后来的'), '2025-01-02T00:00:00.200Z')
    await path('a', 'earlier', await edge('aliased', 3, '先来的'), '2025-01-02T00:00:00.100Z')

    // 只删了路径的节点：Lore 删节点不动 nodes 与 memories，边也可能留着
    await node('path_deleted')
    await version('path_deleted', '删掉的节点的正文')
    await edge('path_deleted', 1, null)

    // 有路径没有正文
    await node('no_body')
    await path('infra', 'no_body', await edge('no_body', 2, null))

    // 正文是 null，时间取这个版本的
    await node('null_body')
    await version('null_body', null)
    await path('infra', 'null_body', await edge('null_body', 2, null))

    // 没废弃的版本有好几条：最新的算数，同一时刻按 id 的数值（字符串比较时 99 排在 100 后面）
    await node('versions')
    await version('versions', '最早的', { at: '2025-01-05T00:00:00Z', id: 98 })
    await version('versions', 'id 99', { at: '2025-03-05T00:00:00Z', id: 99 })
    await version('versions', 'id 100', { at: '2025-03-05T00:00:00Z', id: 100 })
    await path('infra', 'versions', await edge('versions', 2, null))

    // disclosure 是空字符串、时间带微秒（导出只剩毫秒，读库也截到毫秒）
    await node('micro', '2025-01-01T00:00:00.123999Z')
    await version('micro', '微秒', { at: '2025-02-01T00:00:00.654321Z' })
    await path('infra', 'micro', await edge('micro', 2, ''))

    // 引用不到的：路径指向不存在的边、边指向不存在的节点、关键词属于没有路径的节点
    await path('infra', 'no_edge', 999_999)
    await path('infra', 'no_node', await edge('missing', 2, null))
    await keyword('path_deleted', '没人要的词')
  })
  afterAll(async () => {
    await lore?.unsafe('drop schema if exists lore_fixture cascade')
    await lore?.end()
  })

  const byUuid = (snapshot: LoreSnapshot) =>
    new Map(
      snapshot.nodes.map((node) => [node.uuid, { ...node, keywords: [...node.keywords].sort() }]),
    )

  it('按 uuid 比较节点的每一个字段；废弃版本带不带正文都一样', async () => {
    const live = await readLore(lore)
    const exported = await exportLore(lore, '2026-01-01T00:00:00.000Z')
    expect(typeof exported.tables.edges![0]!.id).toBe('string')
    expect(typeof exported.tables.paths![0]!.edge_id).toBe('number')

    for (const input of [exported, withoutDeprecatedContent(exported)]) {
      const { snapshot } = parseLoreBackup(input)
      expect(byUuid(snapshot)).toEqual(byUuid(live))
    }
    // 这些情形确实走到了，不是比了两份空的
    const nodes = byUuid(live)
    expect([...nodes.keys()].sort()).toEqual(
      ['aliased', 'micro', 'no_body', 'null_body', 'plain', 'versions'].sort(),
    )
    expect(nodes.get('aliased')).toMatchObject({
      uri: 'a://earlier',
      aliases: ['b://later'],
      priority: 3,
      disclosure: '先来的',
    })
    expect(nodes.get('plain')).toMatchObject({ content: '现在的正文', previousVersions: 2 })
    expect(nodes.get('versions')!.content).toBe('id 100')
    expect(nodes.get('micro')!.disclosure).toBeNull()
    expect(nodes.get('micro')!.createdAt.toISOString()).toBe('2025-01-01T00:00:00.123Z')
  })
})
