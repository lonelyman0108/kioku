import { describe, expect, it } from 'vitest'

import { planImport, type LoreNode, type LoreSnapshot } from '../lore'

const at = new Date('2026-01-01T00:00:00Z')
const node = (uri: string, extra: Partial<LoreNode> = {}): LoreNode => ({
  uuid: uri,
  uri,
  aliases: [],
  priority: 2,
  disclosure: null,
  content: `${uri} 的正文`,
  createdAt: at,
  updatedAt: at,
  previousVersions: 0,
  keywords: [],
  ...extra,
})
const snapshot = (...nodes: LoreNode[]): LoreSnapshot => ({ nodes, recallEvents: null })
const options = { persona: { slug: 'default', name: '默认人格' }, secretUris: new Set<string>() }

describe('Lore 导入计划', () => {
  it('按 domain 映射到层，core://soul 进人格、core://agent/<runtime> 进应用', () => {
    const plan = planImport(
      snapshot(
        node('core://agent', { priority: 0 }),
        node('core://soul', { priority: 0 }),
        node('core://agent/claudecode', { priority: 0 }),
        node('preferences://user', { priority: 0 }),
        node('infra://home_network', { priority: 1 }),
      ),
      [],
      options,
    )
    expect(plan.memories.map((m) => [m.source, m.request.uri, m.request.layer])).toEqual([
      ['core://agent', 'core://agent', 'base'],
      ['core://soul', 'persona://default/soul', 'persona'],
      ['core://agent/claudecode', 'app://claudecode/agent', 'app'],
      ['preferences://user', 'preferences://user', 'owner'],
      ['infra://home_network', 'infra://home_network', 'private'],
    ])
    expect(plan.memories.map((m) => m.request.priority)).toEqual([0, 0, 0, 0, 1])
  })

  it('运行时先按应用标识匹配，再按运行时类型匹配，都没有就新建', () => {
    const plan = planImport(
      snapshot(
        node('core://agent/claudecode'),
        node('core://agent/zcode'),
        node('core://agent/open_claw/tools'),
      ),
      [
        { slug: 'claude-code', runtimeFamily: 'claudecode' },
        { slug: 'claude-laptop', runtimeFamily: 'claudecode' },
      ],
      options,
    )
    expect(plan.apps).toEqual([
      {
        runtime: 'claudecode',
        apps: [
          { slug: 'claude-code', create: false, runtimeFamily: 'claudecode' },
          { slug: 'claude-laptop', create: false, runtimeFamily: 'claudecode' },
        ],
      },
      { runtime: 'zcode', apps: [{ slug: 'zcode', create: true, runtimeFamily: 'other' }] },
      { runtime: 'open_claw', apps: [{ slug: 'open-claw', create: true, runtimeFamily: 'other' }] },
    ])
    expect(plan.memories.map((m) => m.request.uri)).toEqual([
      'app://claude-code/agent',
      'app://claude-laptop/agent',
      'app://zcode/agent',
      'app://open-claw/agent/tools',
    ])
  })

  it('标成 secret 的导入为 secret，像凭据却没标的给出提醒', () => {
    const plan = planImport(
      snapshot(
        node('infra://home_network/credentials'),
        node('infra://vault/token'),
        node('infra://pve', { content: 'root 密码：hunter2' }),
        node('infra://notes', { content: '密码要同步到 Vaultwarden' }),
      ),
      [],
      { ...options, secretUris: new Set(['infra://home_network/credentials', 'infra://nope']) },
    )
    expect(plan.memories.map((m) => m.request.sensitivity)).toEqual([
      'secret',
      undefined,
      undefined,
      undefined,
    ])
    expect(plan.warnings).toEqual([
      '--secret 指定的 infra://nope 在 Lore 里不存在',
      'infra://vault/token 看起来是凭据，没有用 --secret 标记',
      'infra://pve 的正文里像有密码或 Token，没有用 --secret 标记',
    ])
  })

  it('关键词按接口规则过滤：单字丢弃，超过 32 个时保留较长的', () => {
    const many = Array.from({ length: 34 }, (_, i) => `词${String(i).padStart(2, '0')}`)
    const plan = planImport(
      snapshot(
        node('infra://a', { keywords: ['段', ' 群晖 ', '群晖', 'NAS'] }),
        node('infra://b', { keywords: [...many, '很长的一个关键词'] }),
      ),
      [],
      options,
    )
    expect(plan.memories[0]!.request.glossary).toEqual(['NAS', '群晖'])
    expect(plan.memories[1]!.request.glossary).toHaveLength(32)
    expect(plan.memories[1]!.request.glossary).toContain('很长的一个关键词')
    expect(plan.droppedKeywords.map((k) => [k.source, k.keyword])).toEqual([
      ['infra://a', '段'],
      ['infra://b', '词31'],
      ['infra://b', '词32'],
      ['infra://b', '词33'],
    ])
  })

  it('别名、没有正文、占用保留 domain 的节点不导入，并说明原因', () => {
    const plan = planImport(
      snapshot(
        node('infra://a', { aliases: ['infra://old_a'] }),
        node('infra://empty', { content: null }),
        node('persona://x'),
        node('infra://big', { content: 'x'.repeat(20_001) }),
      ),
      [],
      options,
    )
    expect(plan.memories.map((m) => m.source)).toEqual(['infra://a'])
    expect(plan.skipped.map((s) => s.source)).toEqual([
      'infra://old_a',
      'infra://empty',
      'persona://x',
      'infra://big',
    ])
  })

  it('保留 Lore 的 priority、disclosure 与时间，事件上下文记下出处', () => {
    const created = new Date('2025-05-01T00:00:00Z')
    const plan = planImport(
      snapshot(
        node('projects://kioku', {
          priority: 3,
          disclosure: '讨论 Kioku 时',
          createdAt: created,
          previousVersions: 4,
        }),
      ),
      [],
      options,
    )
    const [m] = plan.memories
    expect(m!.request).toMatchObject({ priority: 3, disclosure: '讨论 Kioku 时' })
    expect(m!.createdAt).toEqual(created)
    expect(m!.context).toEqual({
      source: 'lore',
      loreUri: 'projects://kioku',
      loreNodeUuid: 'projects://kioku',
      previousVersions: 4,
    })
  })
})
