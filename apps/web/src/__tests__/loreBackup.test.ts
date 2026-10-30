import {
  LORE_BACKUP_FORMAT,
  LORE_UPLOAD_MAX_BYTES,
  LoreBackupUpload,
  type LoreImportPlan,
  type LorePlanNode,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  excludeLabel,
  importProblems,
  matchesFilter,
  readLoreBackup,
  secretSelectable,
  selectionOf,
  syncGroups,
  tokenInClear,
  trimLoreBackup,
} from '../loreBackup'

const at = '2026-01-01T00:00:00.000Z'
// 和 Lore 的完整导出相同的形状，带上不该离开浏览器的内容
const fullExport = () => ({
  format: LORE_BACKUP_FORMAT,
  created_at: at,
  stats: { nodes: 1 },
  tables: {
    nodes: [{ uuid: 'n1', created_at: at }],
    memories: [
      { id: '1', node_uuid: 'n1', content: '旧版本里的明文', deprecated: true, created_at: at },
      { id: '2', node_uuid: 'n1', content: '现在的正文', deprecated: false, created_at: at },
    ],
    edges: [{ id: '3', child_uuid: 'n1', priority: 1, disclosure: null }],
    paths: [{ domain: 'infra', path: 'nas', edge_id: 3, created_at: at }],
    glossary_keywords: [{ id: '4', keyword: '存储', node_uuid: 'n1', created_at: at }],
    app_settings: [{ key: 'embedding.api_key', value: { value: 'sk-不该上传' } }],
    memory_events: [{ id: '5', before_snapshot: { content: '事件里的旧正文' } }],
    dream_diary: [{ id: '6', narrative: '日记' }],
    dream_workflow_events: [{ id: '7', payload: {} }],
    glossary_term_embeddings: [{ id: '8', match_text: '存储' }],
    recall_events: [{ id: '9', query_text: '提问' }],
  },
})

describe('裁剪 Lore 的导出', () => {
  it('输出只有 format、created_at 与五张表，废弃行没有正文', () => {
    const trimmed = trimLoreBackup(fullExport())
    expect(Object.keys(trimmed).sort()).toEqual(['created_at', 'format', 'tables'])
    expect(Object.keys(trimmed.tables).sort()).toEqual(
      ['edges', 'glossary_keywords', 'memories', 'nodes', 'paths'].sort(),
    )
    expect(trimmed.format).toBe(LORE_BACKUP_FORMAT)
    expect(trimmed.created_at).toBe(at)
    expect(trimmed.tables.memories[0]).toEqual({
      id: '1',
      node_uuid: 'n1',
      deprecated: true,
      created_at: at,
    })
    expect(trimmed.tables.memories[1]).toMatchObject({ content: '现在的正文' })
    const text = JSON.stringify(trimmed)
    for (const leaked of ['旧版本里的明文', 'sk-不该上传', '事件里的旧正文', '日记', '提问']) {
      expect(text).not.toContain(leaked)
    }
    // 服务端的严格校验收得下
    expect(LoreBackupUpload.safeParse(trimmed).success).toBe(true)
    // 没裁剪的不收
    expect(LoreBackupUpload.safeParse(fullExport()).success).toBe(false)
  })

  it('不是明确没废弃的行也去掉正文，不改动传进来的对象', () => {
    const raw = fullExport()
    raw.tables.memories.push({
      id: '10',
      node_uuid: 'n1',
      content: '来路不明',
      deprecated: 'yes' as unknown as boolean,
      created_at: at,
    })
    const trimmed = trimLoreBackup(raw)
    expect(trimmed.tables.memories[2]).not.toHaveProperty('content')
    expect(raw.tables.memories[0]).toHaveProperty('content')
  })

  it('不是 Lore 的导出、少了表或导出时间时报错', () => {
    for (const bad of [null, 'x', [], {}, { format: 'other', created_at: at, tables: {} }]) {
      expect(() => trimLoreBackup(bad)).toThrow('不是 Lore 的导出文件')
    }
    expect(() => trimLoreBackup({ ...fullExport(), created_at: undefined })).toThrow('导出时间')
    const noTables = { format: LORE_BACKUP_FORMAT, created_at: at }
    expect(() => trimLoreBackup(noTables)).toThrow('没有 nodes 这张表')
    const raw = fullExport() as unknown as { tables: Record<string, unknown> }
    delete raw.tables.glossary_keywords
    expect(() => trimLoreBackup(raw)).toThrow('没有 glossary_keywords 这张表')
  })

  it('读文件：不是 JSON 时报固定的文字，裁剪之后还超过上限时报错', async () => {
    const file = (text: string) => new File([text], 'lore.json')
    await expect(readLoreBackup(file('{"secret":"不是 JSON'))).rejects.toThrow('不是 JSON')
    await expect(readLoreBackup(file('{"secret":"不是 JSON'))).rejects.not.toThrow('secret')
    const trimmed = await readLoreBackup(file(JSON.stringify(fullExport())))
    expect(Object.keys(trimmed.tables)).toHaveLength(5)

    const huge = fullExport()
    huge.tables.nodes = [{ uuid: 'x'.repeat(LORE_UPLOAD_MAX_BYTES), created_at: at }]
    await expect(readLoreBackup(file(JSON.stringify(huge)))).rejects.toThrow('超过')
  })
})

describe('Token 会不会明文传输', () => {
  it('http 且不是内网才算', () => {
    for (const address of ['http://lore.example.com', 'http://8.8.8.8:3000', 'http://172.32.0.1']) {
      expect(tokenInClear(address)).toBe(true)
    }
    for (const address of [
      'https://lore.example.com',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://[fd00::1]/',
      'http://10.0.0.8',
      'http://172.16.0.8',
      'http://192.168.1.2:3000',
      'http://100.100.1.2',
      'http://lore:3000',
      'http://lore.local',
      '不是网址',
      '',
    ]) {
      expect(tokenInClear(address)).toBe(false)
    }
  })
})

const target = (extra: Partial<LorePlanNode['targets'][number]> = {}) => ({
  uri: 'infra://a',
  layer: 'private' as const,
  sensitivity: 'private' as const,
  priority: 2,
  state: 'new' as const,
  boot: false,
  current: [],
  ...extra,
})
const planNode = (uuid: string, extra: Partial<LorePlanNode> = {}): LorePlanNode => ({
  uuid,
  uri: `infra://${uuid}`,
  aliases: [],
  targets: [target()],
  credentialRefs: [],
  credentialHints: { path: false, content: false, extras: false },
  ...extra,
})
const planOf = (
  nodes: LorePlanNode[],
  sync: Partial<LoreImportPlan['sync']> = {},
): LoreImportPlan => ({
  exportedAt: at,
  dataTime: null,
  staleSince: null,
  nodeCount: nodes.length,
  previousVersions: 0,
  fingerprint: 'f',
  secretAvailable: true,
  persona: { slug: 'default', name: '默认人格', exists: true, imported: [] },
  apps: [],
  appsGivenPersona: [],
  appsOtherPersona: [],
  nodes,
  skipped: [],
  droppedKeywords: [],
  warnings: [],
  sync: { items: [], goneFromLore: [], ...sync },
})

describe('勾选', () => {
  const imported = target({ state: 'imported', current: [{ uri: 'infra://a', secret: false }] })

  it('按 uuid 记、发现在的 URI；不导入优先；已导入的 secret 不发；计划里没有的不发', () => {
    const plan = planOf([
      planNode('a'),
      planNode('renamed', { uri: 'infra://new_name' }),
      planNode('both'),
      planNode('old', { targets: [imported] }),
      planNode('kept', { targets: [imported] }),
    ])
    expect(
      selectionOf(
        plan,
        new Set(['a', 'renamed', 'both', 'old', 'kept', 'gone']),
        new Set(['both', 'old', 'also_gone']),
      ),
    ).toEqual({
      secretUris: ['infra://a', 'infra://new_name'],
      excludeUris: ['infra://both', 'infra://old'],
    })
  })

  it('已导入的节点 secret 不起作用，不导入就是这次不同步；还有要新建的目标时照常', () => {
    const old = planNode('old', { targets: [imported] })
    expect(secretSelectable(old)).toBe(false)
    expect(excludeLabel(old)).toBe('这次不同步')
    const moved = planNode('m', { targets: [target({ state: 'moved' })] })
    expect(secretSelectable(moved)).toBe(false)
    expect(excludeLabel(moved)).toBe('这次不同步')
    const mixed = planNode('mixed', { targets: [imported, target()] })
    expect(secretSelectable(mixed)).toBe(true)
    expect(excludeLabel(mixed)).toBe('不导入')
    expect(excludeLabel(planNode('n'))).toBe('不导入')
  })
})

describe('计划的分组', () => {
  it('同步差异每种列出来，已是最新的只给个数，没有的不出现', () => {
    const item = (state: LoreImportPlan['sync']['items'][number]['state'], uri: string) => ({
      source: uri,
      uri,
      state,
      changes: [],
    })
    const { current, groups } = syncGroups(
      planOf([], {
        items: [
          item('current', 'a://1'),
          item('current', 'a://2'),
          { ...item('update', 'a://3'), changes: ['content', 'glossary'] },
          item('edited', 'a://4'),
          { ...item('moved', 'a://5'), target: 'a://6' },
          item('deleted', 'a://7'),
          { ...item('skipped', 'a://8'), reason: '没有正文' },
          item('unmapped', 'a://9'),
          { ...item('unreadable', 'a://10'), reason: '记忆不存在' },
        ],
        goneFromLore: ['a://11'],
      }),
    )
    expect(current).toBe(2)
    expect(groups.map((g) => [g.state, g.lines])).toEqual([
      ['update', ['a://3：正文、关键词']],
      ['edited', ['a://4']],
      ['moved', ['a://5 → a://6']],
      ['deleted', ['a://7']],
      ['skipped', ['a://8：没有正文']],
      ['unmapped', ['a://9']],
      ['unreadable', ['a://10：记忆不存在']],
      ['gone', ['a://11']],
    ])
    expect(syncGroups(planOf([])).groups).toEqual([])
  })

  it('节点的筛选', () => {
    const plain = planNode('plain')
    const boot = planNode('boot', { targets: [target({ boot: true, state: 'imported' })] })
    const refs = planNode('refs', { credentialRefs: ['nas'] })
    const hint = planNode('hint', {
      credentialHints: { path: false, content: false, extras: true },
    })
    const moved = planNode('moved', { targets: [target({ state: 'moved' })] })
    const nodes = [plain, boot, refs, hint, moved]
    const pick = (filter: Parameters<typeof matchesFilter>[1]) =>
      nodes.filter((n) => matchesFilter(n, filter)).map((n) => n.uuid)
    expect(pick('all')).toHaveLength(5)
    expect(pick('new')).toEqual(['plain', 'refs', 'hint'])
    expect(pick('imported')).toEqual(['boot'])
    expect(pick('moved')).toEqual(['moved'])
    expect(pick('boot')).toEqual(['boot'])
    expect(pick('refs')).toEqual(['refs'])
    expect(pick('credential')).toEqual(['hint'])
  })

  it('有失败的或 secret 没生效的，结果不算全部做成', () => {
    const ok = { failed: [], secretAlreadyImported: [], sync: { failed: [] } }
    expect(importProblems(ok)).toBe(false)
    expect(importProblems({ ...ok, failed: [{}] })).toBe(true)
    expect(importProblems({ ...ok, secretAlreadyImported: [{}] })).toBe(true)
    expect(importProblems({ ...ok, sync: { failed: [{}] } })).toBe(true)
  })
})
