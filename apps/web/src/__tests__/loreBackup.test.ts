import {
  LORE_BACKUP_FORMAT,
  LORE_UPLOAD_MAX_BYTES,
  LoreBackupUpload,
  type LoreImportPlan,
  type LorePlanNode,
} from '@kioku/contracts'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import { ApiError } from '../api/client'
import hintSource from '../components/Hint.vue?raw'
import loreImportSource from '../components/LoreImport.vue?raw'
import {
  applyFailureNotice,
  applyFailureOf,
  excludeLabel,
  importProblems,
  LoreFileError,
  matchesFilter,
  planBlocker,
  readLoreBackup,
  replanAfterFailure,
  secretSelectable,
  selectionEffects,
  selectionOf,
  sourceTabs,
  staleNotice,
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
    expect(() => trimLoreBackup(noTables)).toThrow('缺少 nodes 表')
    const raw = fullExport() as unknown as { tables: Record<string, unknown> }
    delete raw.tables.glossary_keywords
    expect(() => trimLoreBackup(raw)).toThrow('缺少 glossary_keywords 表')
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
    expect(excludeLabel(old)).toBe('本次不同步')
    const moved = planNode('m', { targets: [target({ state: 'moved' })] })
    expect(secretSelectable(moved)).toBe(false)
    expect(excludeLabel(moved)).toBe('本次不同步')
    const mixed = planNode('mixed', { targets: [imported, target()] })
    expect(secretSelectable(mixed)).toBe(true)
    expect(excludeLabel(mixed)).toBe('不导入')
    expect(excludeLabel(planNode('n'))).toBe('不导入')
  })
})

describe('勾选之后这次会动什么', () => {
  const none = new Set<string>()
  const updateOf = (node: LorePlanNode, uri = node.targets[0]!.uri) => ({
    source: node.uri,
    uri,
    state: 'update' as const,
    changes: ['content' as const],
  })
  const current = (uri: string | null, secret = false) => ({ uri, secret })

  it('只算会写的：新建且没勾掉，或者有要更新的同步项；数量与徽章看同一份', () => {
    const fresh = planNode('fresh', { targets: [target({ boot: true })] })
    const unticked = planNode('unticked', { targets: [target({ boot: true })] })
    const updated = planNode('updated', {
      targets: [
        target({
          uri: 'infra://updated',
          boot: true,
          state: 'imported',
          current: [current('infra://updated')],
        }),
      ],
    })
    // 下面三种都不写：导入过没变化的、在 Kioku 里删除了的、Lore 里换了路径的
    const unchanged = planNode('unchanged', {
      targets: [
        target({
          uri: 'infra://unchanged',
          boot: true,
          state: 'imported',
          current: [current('infra://unchanged')],
        }),
      ],
    })
    const deleted = planNode('deleted', {
      targets: [target({ boot: true, state: 'imported', current: [current(null)] })],
    })
    const moved = planNode('moved', {
      targets: [target({ boot: true, state: 'moved', current: [current('infra://old')] })],
    })
    const quiet = planNode('quiet', { targets: [target({ boot: false })] })
    const plan = planOf([fresh, unticked, updated, unchanged, deleted, moved, quiet], {
      items: [
        updateOf(updated),
        { ...updateOf(unchanged), state: 'current' },
        { ...updateOf(moved, 'infra://old'), state: 'moved', target: moved.targets[0]!.uri },
      ],
    })
    const effects = selectionEffects(plan, none, new Set(['unticked']))
    expect(effects).toMatchObject({ create: 2, update: 1, bootNodes: 2 })
    expect([...effects.boot]).toEqual([fresh.targets[0], updated.targets[0]])
    // 不带勾选时勾掉的那个也算
    const all = selectionEffects(plan, none, none)
    expect(all).toMatchObject({ create: 3, update: 1, bootNodes: 3 })
    expect(all.boot.has(unticked.targets[0]!)).toBe(true)
    // 全部勾掉就什么都不写
    const uuids = new Set(plan.nodes.map((n) => n.uuid))
    expect(selectionEffects(plan, none, uuids)).toMatchObject({
      create: 0,
      update: 0,
      bootNodes: 0,
    })
  })

  it('要更新的同步项按来源和 URI 对到目标：同一个节点别的目标不跟着算', () => {
    const node = planNode('multi', {
      targets: [
        target({
          uri: 'app://a/agent',
          boot: true,
          state: 'imported',
          current: [current('app://a/agent')],
        }),
        target({
          uri: 'app://b/agent',
          boot: true,
          state: 'imported',
          current: [current('app://b/agent')],
        }),
      ],
    })
    const other = planNode('other')
    const plan = planOf([node, other], {
      items: [
        updateOf(node, 'app://a/agent'),
        // URI 相同、来源是别的节点：对不上这个节点的目标
        updateOf(other, 'app://b/agent'),
      ],
    })
    const effects = selectionEffects(plan, none, none)
    expect(effects.update).toBe(1)
    expect([...effects.boot]).toEqual([node.targets[0]])
  })

  it('secret 不进启动上下文：新建的看这次勾没勾，要更新的看这个 URI 上的记忆现在是不是 secret', () => {
    const fresh = planNode('fresh', { targets: [target({ boot: true })] })
    const secretNow = planNode('secret_now', {
      targets: [
        target({
          uri: 'infra://secret_now',
          boot: true,
          state: 'imported',
          current: [current('infra://secret_now', true)],
        }),
      ],
    })
    // 早期导入过两条：移走的那条是 secret，这次要更新的这条是明文
    const mixed = planNode('mixed', {
      targets: [
        target({
          uri: 'infra://mixed',
          boot: true,
          state: 'imported',
          current: [current('infra://mixed_old', true), current('infra://mixed')],
        }),
      ],
    })
    const plan = planOf([fresh, secretNow, mixed], {
      items: [updateOf(secretNow), updateOf(mixed)],
    })
    const plain = selectionEffects(plan, none, none)
    expect([...plain.boot]).toEqual([fresh.targets[0], mixed.targets[0]])
    expect(plain.bootNodes).toBe(2)
    const ticked = selectionEffects(plan, new Set(['fresh']), none)
    expect([...ticked.boot]).toEqual([mixed.targets[0]])
    expect(ticked).toMatchObject({ bootNodes: 1, create: 1, update: 2 })
  })

  it('引用的凭据只算这次会写的节点', () => {
    const fresh = planNode('fresh', { credentialRefs: ['nas', 'ap'] })
    const unticked = planNode('unticked', { credentialRefs: ['unticked'] })
    const unchanged = planNode('unchanged', {
      credentialRefs: ['unchanged'],
      targets: [target({ state: 'imported', current: [current('infra://a')] })],
    })
    const moved = planNode('moved', {
      credentialRefs: ['moved'],
      targets: [target({ state: 'moved', current: [current('infra://b')] })],
    })
    const updated = planNode('updated', {
      credentialRefs: ['updated', 'nas'],
      targets: [
        target({
          uri: 'infra://updated',
          state: 'imported',
          current: [current('infra://updated')],
        }),
      ],
    })
    const plan = planOf([fresh, unticked, unchanged, moved, updated], {
      items: [updateOf(updated)],
    })
    expect(selectionEffects(plan, none, new Set(['unticked'])).credentialRefs).toEqual([
      'ap',
      'nas',
      'updated',
    ])
  })

  describe('人格', () => {
    const soulTarget = (extra: Parameters<typeof target>[0] = {}) =>
      target({ uri: 'persona://default/soul', layer: 'persona', ...extra })
    const soul = planNode('soul', { targets: [soulTarget()] })
    const other = planNode('other')

    it('有要新建的人格层目标才算写入新的 soul：勾掉的、已导入的、换了路径的都不算', () => {
      const plan = planOf([soul, other])
      expect(selectionEffects(plan, none, none).writesPersona).toBe(true)
      expect(selectionEffects(plan, none, new Set(['other'])).writesPersona).toBe(true)
      expect(selectionEffects(plan, none, new Set(['soul'])).writesPersona).toBe(false)
      expect(selectionEffects(planOf([other]), none, none).writesPersona).toBe(false)
      const prior = [current('persona://default/soul')]
      for (const state of ['imported', 'moved'] as const) {
        const old = planNode('soul', { targets: [soulTarget({ state, current: prior })] })
        expect(selectionEffects(planOf([old, other]), none, none).writesPersona).toBe(false)
        // 同一个人格下还有要新建的节点
        const style = planNode('style', {
          targets: [soulTarget({ uri: 'persona://default/soul/style' })],
        })
        expect(selectionEffects(planOf([old, style]), none, none).writesPersona).toBe(true)
      }
    })

    it('人格已有时跳过 soul 不改变应用用哪个人格；不存在时只有写入新的 soul 才设', () => {
      const claude = planNode('claude', {
        uri: 'core://agent/claude',
        targets: [target({ uri: 'app://claude/agent', layer: 'app' })],
      })
      const planWith = (exists: boolean): LoreImportPlan => ({
        ...planOf([soul, claude]),
        persona: { slug: 'default', name: '默认人格', exists, imported: [] },
        apps: [
          {
            runtime: 'claude',
            apps: [
              { slug: 'claude', create: false, runtimeFamily: 'mcp' },
              { slug: 'claude-work', create: false, runtimeFamily: 'mcp' },
            ],
          },
        ],
        appsGivenPersona: ['claude'],
        appsOtherPersona: ['claude-work'],
      })
      const lists = (plan: LoreImportPlan, excluded: string[]) => {
        const { appsGivenPersona, appsOtherPersona } = selectionEffects(
          plan,
          none,
          new Set(excluded),
        )
        return [appsGivenPersona, appsOtherPersona]
      }
      const both = [['claude'], ['claude-work']]
      const neither = [[], []]
      expect(lists(planWith(false), [])).toEqual(both)
      expect(lists(planWith(false), ['soul'])).toEqual(neither)
      expect(lists(planWith(true), [])).toEqual(both)
      expect(lists(planWith(true), ['soul'])).toEqual(both)
      // 全部勾掉就什么都不改
      expect(lists(planWith(true), ['soul', 'claude'])).toEqual(neither)
    })
  })

  it('勾掉一个运行时下的全部节点，它的应用不再列出；没有节点可勾的已有应用不随勾选变；全部勾掉什么都不动', () => {
    const appTarget = (slug: string) => target({ uri: `app://${slug}/agent`, layer: 'app' })
    const claude = planNode('claude', {
      uri: 'core://agent/claude',
      targets: [appTarget('claude')],
    })
    const tools = planNode('tools', {
      uri: 'core://agent/claude/tools',
      targets: [target({ uri: 'app://claude/agent/tools', layer: 'app' })],
    })
    // 名字有相同前缀的运行时不算在内
    const longer = planNode('longer', {
      uri: 'core://agent/claude_web',
      targets: [appTarget('claude-web')],
    })
    const zcode = planNode('zcode', { uri: 'core://agent/zcode', targets: [appTarget('zcode')] })
    const plan: LoreImportPlan = {
      ...planOf([claude, tools, longer, zcode]),
      apps: [
        { runtime: 'claude', apps: [{ slug: 'claude', create: false, runtimeFamily: 'mcp' }] },
        {
          runtime: 'claude_web',
          apps: [{ slug: 'claude-web', create: true, runtimeFamily: 'other' }],
        },
        { runtime: 'zcode', apps: [{ slug: 'zcode', create: false, runtimeFamily: 'other' }] },
        // 这个运行时的节点都在映射之后被跳过了，服务端照常设默认人格，界面上没有节点可勾
        { runtime: 'hidden', apps: [{ slug: 'hidden', create: false, runtimeFamily: 'other' }] },
      ],
      appsGivenPersona: ['claude', 'hidden'],
      appsOtherPersona: ['zcode'],
    }
    const pick = (excluded: string[]) => {
      const { apps, appsGivenPersona, appsOtherPersona } = selectionEffects(
        plan,
        none,
        new Set(excluded),
      )
      return { runtimes: apps.map((m) => m.runtime), appsGivenPersona, appsOtherPersona }
    }
    expect(pick([])).toEqual({
      runtimes: ['claude', 'claude_web', 'zcode', 'hidden'],
      appsGivenPersona: ['claude', 'hidden'],
      appsOtherPersona: ['zcode'],
    })
    // 还有一个节点留着，这个运行时还在
    expect(pick(['claude']).runtimes).toEqual(['claude', 'claude_web', 'zcode', 'hidden'])
    expect(pick(['claude', 'tools'])).toEqual({
      runtimes: ['claude_web', 'zcode', 'hidden'],
      appsGivenPersona: ['hidden'],
      appsOtherPersona: ['zcode'],
    })
    expect(pick(['zcode'])).toEqual({
      runtimes: ['claude', 'claude_web', 'hidden'],
      appsGivenPersona: ['claude', 'hidden'],
      appsOtherPersona: [],
    })
    expect(pick(['longer']).runtimes).toEqual(['claude', 'zcode', 'hidden'])
    // 全部勾掉就什么都不动，没有节点可勾的也一样
    expect(pick(['claude', 'tools', 'longer', 'zcode'])).toEqual({
      runtimes: [],
      appsGivenPersona: [],
      appsOtherPersona: [],
    })
    // 计划里本来就没有节点时没有勾选可言，服务端照常设
    const onlyHidden = { ...plan, nodes: [] }
    expect(selectionEffects(onlyHidden, none, none).apps.map((m) => m.runtime)).toContain('hidden')
  })
})

describe('文件比已写入的数据旧', () => {
  const dataTime = '2026-02-01T00:00:00.000Z'
  const stale = (extra: Partial<LoreImportPlan>): LoreImportPlan => ({
    ...planOf([planNode('a')]),
    dataTime,
    ...extra,
  })

  it('勾选之后还有要写的才要确认，没有要写的不要求确认', () => {
    const plan = stale({ staleSince: dataTime })
    expect(staleNotice(plan, { create: 1, update: 0 })).toBe('confirm')
    expect(staleNotice(plan, { create: 0, update: 1 })).toBe('confirm')
    // 全部勾掉：计划里带着 staleSince，这次却什么都不写
    expect(staleNotice(plan, { create: 0, update: 0 })).toBe('older')
    expect(
      staleNotice(plan, selectionEffects(plan, new Set(), new Set(plan.nodes.map((n) => n.uuid)))),
    ).toBe('older')
    expect(staleNotice(plan, selectionEffects(plan, new Set(), new Set()))).toBe('confirm')
  })

  it('本来就没有要写的只说一声；不比已写入的数据旧时什么都不说', () => {
    expect(staleNotice(stale({ staleSince: null }), { create: 0, update: 0 })).toBe('older')
    expect(staleNotice(stale({ exportedAt: dataTime }), { create: 1, update: 0 })).toBeNull()
    expect(
      staleNotice(stale({ exportedAt: '2026-03-01T00:00:00.000Z' }), { create: 1, update: 0 }),
    ).toBeNull()
    // 还没写入过，或者拉取来源
    expect(staleNotice(stale({ dataTime: null }), { create: 1, update: 0 })).toBeNull()
  })
})

describe('执行失败之后的说明', () => {
  const PARTLY = '可能已写入一部分'

  it('确定什么都没写的：显示服务端的文字，不说写了一部分，不重看计划', () => {
    for (const status of [400, 401, 403, 404, 413, 429]) {
      expect(applyFailureOf(new ApiError(status, '服务端的文字'))).toEqual({
        kind: 'refused',
        message: '服务端的文字',
      })
    }
    expect(applyFailureOf(new LoreFileError('文件的问题'))).toEqual({
      kind: 'refused',
      message: '文件的问题',
    })
  })

  it('计划变了（409）：什么都没写，重看计划', () => {
    const failure = applyFailureOf(new ApiError(409, '计划变了'))
    expect(failure.kind).toBe('changed')
    const text = applyFailureNotice(failure, 'replanned')
    expect(text).toBe('计划变了。计划已重新生成，勾选已保留。')
    expect(text).not.toContain(PARTLY)
  })

  it('5xx 与网络错误才说可能写了一部分并重看计划：文字是界面自己的，不看服务端说了什么', () => {
    for (const [err, message] of [
      // 服务端写到一半时自己也说了一遍，不能重复，也不能因为它改了文字就不说
      [new ApiError(500, '写入中途出错，可能已写入一部分'), '服务端错误（HTTP 500）'],
      [new ApiError(500, '服务内部错误'), '服务端错误（HTTP 500）'],
      [new ApiError(502, '请求失败：HTTP 502'), '服务端错误（HTTP 502）'],
      [new ApiError(504, '请求失败：HTTP 504'), '服务端错误（HTTP 504）'],
      // 网络错误的英文原文不给人看
      [new TypeError('Failed to fetch'), '网络错误'],
    ] as const) {
      const failure = applyFailureOf(err)
      expect(failure).toEqual({ kind: 'partial', message })
      expect(applyFailureNotice(failure, 'replanned')).toBe(
        `${message}。${PARTLY}。计划已重新生成：已写入的显示为已导入，勾选已保留，再次确认即可继续。`,
      )
    }
  })

  it('接着的看计划也失败时，不说已经重新算过', () => {
    for (const failure of [
      applyFailureOf(new ApiError(409, '计划变了')),
      applyFailureOf(new ApiError(500, '写入中途出错')),
      applyFailureOf(new TypeError('Failed to fetch')),
    ]) {
      const text = applyFailureNotice(failure, 'failed')
      expect(text).not.toContain('计划已重新生成')
      expect(text).toContain('重新生成计划也失败了')
      expect(text).toContain('勾选已保留')
      expect(text.startsWith(failure.message)).toBe(true)
    }
    expect(applyFailureNotice(applyFailureOf(new TypeError('x')), 'failed')).toContain(PARTLY)
    expect(
      applyFailureNotice(applyFailureOf(new ApiError(409, '计划变了')), 'failed'),
    ).not.toContain(PARTLY)
  })

  it('重看计划之前就有说明，算完再更新：慢的地址拉取期间不能是一片空白', async () => {
    const failure = applyFailureOf(new ApiError(500, '写入中途出错'))
    const shown: string[] = []
    let finish!: (replanned: boolean) => void
    const replan = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)))
    const done = replanAfterFailure(failure, replan, (text) => shown.push(text))

    // 还在重算：已经说清楚发生了什么，不说算好了
    expect(replan).toHaveBeenCalledTimes(1)
    expect(shown).toEqual([applyFailureNotice(failure, 'replanning')])
    expect(shown[0]).toContain(failure.message)
    expect(shown[0]).toContain(PARTLY)
    expect(shown[0]).toContain('正在重新生成计划')
    expect(shown[0]).not.toContain('计划已重新生成')

    finish(true)
    await done
    expect(shown).toEqual([
      applyFailureNotice(failure, 'replanning'),
      applyFailureNotice(failure, 'replanned'),
    ])

    const failed: string[] = []
    await replanAfterFailure(
      failure,
      () => Promise.resolve(false),
      (text) => failed.push(text),
    )
    expect(failed.at(-1)).toBe(applyFailureNotice(failure, 'failed'))
  })

  it('计划变了（409）在重算期间不说写了一部分', () => {
    const text = applyFailureNotice(applyFailureOf(new ApiError(409, '计划变了')), 'replanning')
    expect(text).toBe('计划变了。正在重新生成计划，勾选已保留。')
  })
})

// 模板解析出来的节点：看标签、属性与事件，不依赖排版。没有组件测试的环境，所以看模板本身
interface TemplateNode {
  type: number
  tag?: string
  content?: string
  children?: TemplateNode[]
  props?: {
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const TEXT = 2
const walk = (node: TemplateNode): TemplateNode[] => [node, ...(node.children ?? []).flatMap(walk)]
const { descriptor } = parse(loreImportSource)
const root = descriptor.template!.ast as unknown as TemplateNode
const elements = walk(root).filter((n) => n.type === ELEMENT)

describe('写入只来自点确认导入', () => {
  const handler = (el: TemplateNode, event: string) =>
    el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
  const staticType = (el: TemplateNode) => el.props?.find((p) => p.name === 'type')?.value?.content
  const buttonOf = (label: string) =>
    elements.find(
      (el) =>
        el.tag === 'UButton' &&
        walk(el).some((n) => n.type === TEXT && n.content?.trim() === label),
    )!

  it('确认导入不是提交按钮：不然回车的隐式提交会点它', () => {
    const confirm = buttonOf('确认导入')
    expect(handler(confirm, 'click')).toBe('applyPlan')
    expect(staticType(confirm)).not.toBe('submit')
    // 计划显示时表单里没有提交按钮，只有看计划这一个
    expect(elements.filter((el) => staticType(el) === 'submit')).toEqual([buttonOf('查看计划')])
  })

  it('表单的提交不执行，模板里只有确认导入一处执行', () => {
    const form = elements.find((el) => el.tag === 'form')!
    expect(handler(form, 'submit')).toBe('onSubmit')
    const applying = elements.filter((el) =>
      el.props?.some((p) => p.exp?.content.includes('applyPlan')),
    )
    expect(applying).toEqual([buttonOf('确认导入')])
    // 提交的处理函数只看计划，脚本里也没有别的地方调用执行
    const script = descriptor.scriptSetup!.content
    const onSubmit = /function onSubmit\(\) \{[^}]*\}/.exec(script)![0]
    expect(onSubmit).toContain('replan')
    expect(onSubmit).not.toContain('applyPlan')
    expect(script.match(/applyPlan/g)).toEqual(['applyPlan'])
  })

  it('表单里的提示层不是提交按钮：点开说明不能触发提交，也不能被回车的隐式提交点到', () => {
    expect(elements.some((el) => el.tag === 'Hint')).toBe(true)
    const hint = parse(hintSource).descriptor.template!.ast as unknown as TemplateNode
    const buttons = walk(hint).filter((el) => el.type === ELEMENT && el.tag === 'button')
    expect(buttons.map(staticType)).toEqual(['button'])
  })
})

describe('请求期间与不能看计划时', () => {
  const script = descriptor.scriptSetup!.content

  it('来源的分页在请求期间禁用：切换来源会清掉计划与说明', () => {
    const tabs = elements.find((el) => el.tag === 'UTabs')!
    const items = tabs.props?.find((p) => p.name === 'bind' && p.arg?.content === 'items')
    expect(items?.exp?.content).toBe('sourceTabs(busy)')
    expect(sourceTabs(true).map((t) => [t.value, t.disabled])).toEqual([
      ['file', true],
      ['url', true],
    ])
    expect(sourceTabs(false).map((t) => [t.value, t.disabled])).toEqual([
      ['file', false],
      ['url', false],
    ])
  })

  it('不能看计划时总说得出原因；能看时没有', () => {
    const form = {
      busy: false,
      sourceKind: 'file' as const,
      hasFile: true,
      tooLarge: false,
      url: '',
      personaProblem: null,
      personaName: '默认人格',
    }
    expect(planBlocker(form)).toBeNull()
    expect(planBlocker({ ...form, sourceKind: 'url', hasFile: false, url: 'https://x' })).toBeNull()
    expect(planBlocker({ ...form, busy: true })).toBe('上一个请求尚未结束')
    expect(planBlocker({ ...form, personaProblem: '只能包含小写字母' })).toBe(
      '人格标识只能包含小写字母',
    )
    expect(planBlocker({ ...form, personaName: '' })).toBe('请填写人格名称')
    expect(planBlocker({ ...form, hasFile: false })).toBe('请选择 Lore 的导出文件')
    expect(planBlocker({ ...form, tooLarge: true })).toBe('导出文件超过上限')
    expect(planBlocker({ ...form, sourceKind: 'url' })).toBe('请填写 Lore 地址')
  })

  it('按钮看的和看计划看的是同一个原因；不能看时写进错误：失败说明会让人看下面的错误', () => {
    expect(script).toContain('const ready = computed(() => !blocker.value)')
    const showPlan = /async function showPlan\(\)[^]*?\n\}/.exec(script)![0]
    expect(showPlan).toMatch(
      /if \(!ready\.value\) \{\s*error\.value = blocker\.value\s*return false/,
    )
  })

  it('执行失败之后经 replanAfterFailure 重看计划：说明在重算之前就给出', () => {
    const applyPlan = /async function applyPlan\(\)[^]*?\n\}/.exec(script)![0]
    expect(applyPlan).toContain('await replanAfterFailure(failure, showPlan,')
    expect(applyPlan).not.toContain('await showPlan()')
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
          { ...item('skipped', 'a://8'), reason: '正文为空' },
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
      ['skipped', ['a://8：正文为空']],
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
      nodes.filter((n) => matchesFilter(n, filter, new Set(boot.targets))).map((n) => n.uuid)
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
