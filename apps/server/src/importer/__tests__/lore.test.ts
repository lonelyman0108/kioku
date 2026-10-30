import { describe, expect, it } from 'vitest'

import {
  assertExecutable,
  credentialHints,
  planFingerprint,
  planImport,
  type ImportPlan,
  type ImportPreview,
  type LoreNode,
  type LoreSnapshot,
  type SyncPlan,
} from '../lore'

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
const ME = 'me'
const options = {
  accountId: ME,
  persona: { slug: 'default', name: '默认人格' },
  secretUris: new Set<string>(),
}

describe('Lore 导入计划', () => {
  it('按 domain 映射到层，core://soul 进人格、core://agent/<runtime> 进应用', () => {
    const plan = planImport(
      snapshot(
        node('core://agent', { priority: 0 }),
        node('core://soul', { priority: 0 }),
        node('core://agent/claudecode', { priority: 0 }),
        node('preferences://user', { priority: 0 }),
        node('infra://office_network', { priority: 1 }),
      ),
      [],
      options,
    )
    expect(plan.memories.map((m) => [m.source, m.request.uri, m.request.layer])).toEqual([
      ['core://agent', 'core://agent', 'base'],
      ['core://soul', 'persona://default/soul', 'persona'],
      ['core://agent/claudecode', 'app://claudecode/agent', 'app'],
      ['preferences://user', 'preferences://user', 'owner'],
      ['infra://office_network', 'infra://office_network', 'private'],
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
        { slug: 'claude-code', runtimeFamily: 'claudecode', ownerAccountId: ME },
        { slug: 'claude-laptop', runtimeFamily: 'claudecode', ownerAccountId: ME },
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

  it('只用导入者自己的应用：别人的同类应用不写，别人占了同名标识时跳过并说明', () => {
    const plan = planImport(
      snapshot(node('core://agent/claudecode'), node('core://agent/codex')),
      [
        { slug: 'bob-cc', runtimeFamily: 'claudecode', ownerAccountId: 'bob' },
        { slug: 'codex', runtimeFamily: 'codex', ownerAccountId: 'bob' },
      ],
      options,
    )
    expect(plan.memories.map((m) => m.request.uri)).toEqual(['app://claudecode/agent'])
    expect(plan.apps).toEqual([
      {
        runtime: 'claudecode',
        apps: [{ slug: 'claudecode', create: true, runtimeFamily: 'claudecode' }],
      },
    ])
    expect(plan.skipped).toEqual([
      {
        source: 'core://agent/codex',
        reason:
          '应用标识 codex 已被别的成员占用：先在管理界面建一个自己的、运行时类型为 codex 的应用，再重新导入',
      },
    ])
  })

  it('按类型匹配时不用标识归另一个运行时的应用；映射到同一个 URI 时只导入第一个', () => {
    const plan = planImport(
      snapshot(node('core://agent/claudecode'), node('core://agent/zcode')),
      [
        { slug: 'claude-code', runtimeFamily: 'claudecode', ownerAccountId: ME },
        { slug: 'zcode', runtimeFamily: 'claudecode', ownerAccountId: ME },
      ],
      options,
    )
    expect(plan.memories.map((m) => [m.source, m.request.uri])).toEqual([
      ['core://agent/claudecode', 'app://claude-code/agent'],
      ['core://agent/zcode', 'app://zcode/agent'],
    ])

    const twice = planImport(
      snapshot(
        node('core://soul'),
        node('persona://default/soul'),
        node('core://soul', { uuid: 'x' }),
      ),
      [],
      options,
    )
    expect(twice.memories).toHaveLength(1)
    expect(twice.skipped.map((s) => s.reason)).toContain(
      '和 core://soul 映射到同一个 persona://default/soul',
    )
  })

  it('凭据提醒也看别名、disclosure 与关键词；secret 节点的 disclosure 与关键词是明文，也提醒', () => {
    const plan = planImport(
      snapshot(
        node('core://notes/router', { aliases: ['infra://router/credentials'] }),
        node('infra://nas', { keywords: ['token: abcdef'] }),
        node('infra://keystore', { disclosure: '要用 password: 时' }),
      ),
      [],
      { ...options, secretUris: new Set(['infra://keystore']) },
    )
    expect(plan.warnings).toEqual([
      { uri: 'core://notes/router', kind: 'credentialPath' },
      { uri: 'infra://nas', kind: 'credentialExtras' },
      { uri: 'infra://keystore', kind: 'secretExtras' },
    ])
  })

  it('人格目标的去重键带上人格：换一个 --persona 是另一份', () => {
    const a = planImport(snapshot(node('core://soul')), [], options)
    const b = planImport(snapshot(node('core://soul')), [], {
      ...options,
      persona: { slug: 'work', name: 'work' },
    })
    expect(a.memories[0]!.importKey).not.toBe(b.memories[0]!.importKey)
  })

  it('标成 secret 的导入为 secret（也可以写别名），对不上的 --secret 是错误；像凭据却没标的给出提醒', () => {
    const plan = planImport(
      snapshot(
        node('infra://office_network/credentials', { aliases: ['infra://router/credentials'] }),
        node('infra://keystore/token'),
        node('infra://hypervisor', { content: 'root 密码：hunter2' }),
        node('infra://notes', { content: '密码要同步到密码库' }),
      ),
      [],
      { ...options, secretUris: new Set(['infra://router/credentials', 'infra://nope']) },
    )
    expect(plan.memories.map((m) => m.request.sensitivity)).toEqual([
      'secret',
      undefined,
      undefined,
      undefined,
    ])
    expect(plan.errors).toEqual([{ kind: 'secretNotFound', uri: 'infra://nope' }])
    expect(plan.warnings).toEqual([
      { uri: 'infra://keystore/token', kind: 'credentialPath' },
      { uri: 'infra://hypervisor', kind: 'credentialContent' },
    ])
  })

  it('关键词按接口规则过滤：单字丢弃，超过 32 个时保留较长的', () => {
    const many = Array.from({ length: 34 }, (_, i) => `词${String(i).padStart(2, '0')}`)
    const plan = planImport(
      snapshot(
        node('infra://a', { keywords: ['段', ' 存储 ', '存储', 'NAS'] }),
        node('infra://b', { keywords: [...many, '很长的一个关键词'] }),
      ),
      [],
      options,
    )
    expect(plan.memories[0]!.request.glossary).toEqual(['NAS', '存储'])
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

  it('格式不对的凭据占位符、写在 disclosure 里的占位符，在计划里就不导入并说明原因', () => {
    const plan = planImport(
      snapshot(
        node('projects://notes', { content: '占位符写成 {{cred:<标识>#<字段>}}' }),
        node('projects://ok', { content: '占位符写成 cred:<标识>#<字段>，外面套两层花括号' }),
        node('infra://hint', { disclosure: '要用 {{cred:router#password}} 登录时' }),
        // 截断之后才是真正写进去的 disclosure，后面的部分不算
        node('infra://long', { disclosure: `${'长'.repeat(500)}{{cred:router}}` }),
      ),
      [],
      options,
    )
    expect(plan.memories.map((m) => m.source)).toEqual(['projects://ok', 'infra://long'])
    expect(plan.skipped).toEqual([
      {
        source: 'projects://notes',
        reason: '正文里有格式不对的凭据占位符：写到这种写法的说明文字要去掉花括号',
      },
      { source: 'infra://hint', reason: expect.stringContaining('占位符只能写在正文里') },
    ])
  })

  it('跳过的原因默认不引用正文；命令行才引用那段格式不对的占位符', () => {
    const snap = snapshot(
      node('infra://hint', { content: '说明 {{cred:nas 密码是 hunter2 不要外传' }),
    )
    expect(JSON.stringify(planImport(snap, [], options))).not.toContain('hunter2')
    expect(planImport(snap, [], { ...options, quoteMalformed: true }).skipped).toEqual([
      {
        source: 'infra://hint',
        reason:
          '正文里有格式不对的凭据占位符 {{cred:nas 密码是 hunter2 不要外传：写到这种写法的说明文字要去掉花括号',
      },
    ])
  })

  it('关键词里的占位符只丢掉那个关键词，节点照常导入', () => {
    const plan = planImport(
      snapshot(node('infra://tagged', { keywords: ['{{cred:router}}', '路由器'] })),
      [],
      options,
    )
    expect(plan.memories.map((m) => m.request.glossary)).toEqual([['路由器']])
    expect(plan.droppedKeywords).toEqual([
      {
        source: 'infra://tagged',
        keyword: '{{cred:router}}',
        reason: expect.stringContaining('占位符只能写在正文里'),
      },
    ])
  })

  it('正文里有占位符的节点只能进私人层：映射到基础层、主人层的在计划里就不导入', () => {
    const body = '登录用 {{cred:router#password}}'
    const plan = planImport(
      snapshot(
        node('projects://router', { content: body }),
        node('core://router', { content: body }),
        node('preferences://router', { content: body }),
      ),
      [],
      options,
    )
    expect(plan.memories.map((m) => m.source)).toEqual(['projects://router'])
    expect(plan.skipped).toEqual([
      { source: 'core://router', reason: expect.stringContaining('core://router 是 base 层') },
      {
        source: 'preferences://router',
        reason: expect.stringContaining('preferences://router 是 owner 层'),
      },
    ])
  })

  it('disclosure 超长时截断并提醒；像凭据的路径、正文、disclosure 或关键词分开给出', () => {
    const plan = planImport(
      snapshot(node('infra://long', { disclosure: '长'.repeat(501) })),
      [],
      options,
    )
    expect(plan.warnings).toEqual([{ uri: 'infra://long', kind: 'disclosureTruncated' }])
    expect(plan.memories[0]!.request.disclosure).toHaveLength(500)

    expect(credentialHints(node('infra://plain'))).toEqual({
      path: false,
      content: false,
      extras: false,
    })
    expect(
      credentialHints(
        node('infra://notes', { aliases: ['infra://old/token'], keywords: ['token: abcdef'] }),
      ),
    ).toEqual({ path: true, content: false, extras: true })
    expect(credentialHints(node('infra://hv', { content: '密码：hunter2' }))).toEqual({
      path: false,
      content: true,
      extras: false,
    })
  })

  describe('这次不导入的节点', () => {
    const zcodeApps = [
      { slug: 'claude-code', runtimeFamily: 'claudecode', ownerAccountId: ME },
      { slug: 'zcode', runtimeFamily: 'claudecode', ownerAccountId: ME },
    ]

    it('在循环里按节点跳过：别的节点的应用映射不变，别名和主路径都指得到它', () => {
      const snap = snapshot(
        node('core://agent/claudecode'),
        node('core://agent/zcode', { aliases: ['core://agent/zc'] }),
      )
      const all = planImport(snap, zcodeApps, options)
      for (const uri of ['core://agent/zcode', 'core://agent/zc']) {
        const plan = planImport(snap, zcodeApps, { ...options, excludeUris: new Set([uri]) })
        expect(plan.errors).toEqual([])
        // 跳过 zcode 之后，core://agent/claudecode 不能因为少了一个运行时就写进 zcode 这个应用
        expect(plan.memories.map((m) => m.request.uri)).toEqual(['app://claude-code/agent'])
        expect(plan.memories[0]!.importKey).toBe(all.memories[0]!.importKey)
        expect(plan.skipped).toContainEqual({
          source: 'core://agent/zcode',
          reason: '这次选择不导入',
        })
        expect(plan.apps.map((m) => m.runtime)).toEqual(['claudecode'])
      }
    })

    it('勾掉的节点写到的 URI 还占着：映射到同一个 URI 的下一个节点不顶上来', () => {
      const snap = snapshot(
        node('core://agent/claude_code'),
        node('core://agent/claude-code'),
        node('infra://other'),
      )
      const all = planImport(snap, [], options)
      expect(all.memories.map((m) => [m.source, m.request.uri])).toEqual([
        ['core://agent/claude_code', 'app://claude-code/agent'],
        ['infra://other', 'infra://other'],
      ])
      const clash = {
        source: 'core://agent/claude-code',
        reason: '和 core://agent/claude_code 映射到同一个 app://claude-code/agent',
      }
      expect(all.skipped).toEqual([clash])

      const plan = planImport(snap, [], {
        ...options,
        excludeUris: new Set(['core://agent/claude_code']),
      })
      // 第二个节点在计划里没有写入目标，看不到也勾不了，不能在勾掉第一个之后写进去
      expect(plan.memories.map((m) => m.source)).toEqual(['infra://other'])
      expect(plan.skipped).toEqual([
        { source: 'core://agent/claude_code', reason: '这次选择不导入' },
        clash,
      ])
      expect(plan.errors).toEqual([])
    })

    it('不管勾掉哪些节点，写入的都是不勾时减去勾掉的', () => {
      const mine = [
        { slug: 'claude-a', runtimeFamily: 'claudecode', ownerAccountId: ME },
        { slug: 'claude-b', runtimeFamily: 'claudecode', ownerAccountId: ME },
      ]
      const snap = snapshot(
        node('core://soul'),
        // 写到两个应用
        node('core://agent/claudecode'),
        // 三个节点映射到同一个 URI，子路径上也有一对
        node('core://agent/open_claw_x'),
        node('core://agent/open-claw_x'),
        node('core://agent/open_claw-x'),
        node('core://agent/open_claw_x/tools'),
        node('core://agent/open-claw-x/tools'),
        node('infra://other', { aliases: ['infra://old'] }),
        node('infra://empty', { content: null }),
      )
      const writes = (plan: ImportPlan) =>
        plan.memories.map((m) => ({ source: m.source, uri: m.request.uri, key: m.importKey }))
      const base = planImport(snap, mine, options)
      expect(base.memories).toHaveLength(6)
      const baseApps = base.apps.flatMap((m) => m.apps.map((a) => a.slug))
      const uris = snap.nodes.map((n) => n.uri)
      for (let mask = 0; mask < 1 << uris.length; mask++) {
        const excluded = uris.filter((_, i) => mask & (1 << i))
        const plan = planImport(snap, mine, { ...options, excludeUris: new Set(excluded) })
        expect(plan.errors).toEqual([])
        expect(writes(plan)).toEqual(writes(base).filter((w) => !excluded.includes(w.source)))
        expect(baseApps).toEqual(
          expect.arrayContaining(plan.apps.flatMap((m) => m.apps.map((a) => a.slug))),
        )
      }
      // 全部勾掉就什么都不写，应用也不建
      const none = planImport(snap, mine, { ...options, excludeUris: new Set(uris) })
      expect(none.memories).toEqual([])
      expect(none.apps).toEqual([])
    })

    it('对不上任何节点时是错误；同时标了 secret 时以不导入为准', () => {
      const plan = planImport(snapshot(node('infra://a')), [], {
        ...options,
        secretUris: new Set(['infra://a']),
        excludeUris: new Set(['infra://a', 'infra://nope']),
      })
      expect(plan.errors).toEqual([{ kind: 'excludeNotFound', uri: 'infra://nope' }])
      expect(plan.memories).toEqual([])
      expect(plan.skipped.map((s) => s.source)).toEqual(['infra://a'])
    })
  })

  describe('写入之前共用的检查', () => {
    const key = Buffer.alloc(32)
    it('计划有错误时拒绝，文字不提命令行的参数', () => {
      const plan = planImport(snapshot(node('infra://a')), [], {
        ...options,
        secretUris: new Set(['infra://nope']),
        excludeUris: new Set(['infra://gone']),
      })
      expect(() => assertExecutable(plan, key)).toThrow(/infra:\/\/nope.*infra:\/\/gone/)
      expect(() => assertExecutable(plan, key)).not.toThrow(/--secret/)
    })
    it('要 secret 又没有主密钥时拒绝，不要 secret 时不需要主密钥', () => {
      const secret = planImport(snapshot(node('infra://a')), [], {
        ...options,
        secretUris: new Set(['infra://a']),
      })
      expect(() => assertExecutable(secret, null)).toThrow('没有配置主密钥')
      expect(() => assertExecutable(secret, key)).not.toThrow()
      const plain = planImport(snapshot(node('infra://a')), [], options)
      expect(() => assertExecutable(plain, null)).not.toThrow()
    })
  })

  it('有导出时间时记进事件的 context，读库（命令行）时没有这一项；去重键不变', () => {
    const snap = snapshot(node('infra://a'))
    const fromLive = planImport(snap, [], options)
    const fromFile = planImport(snap, [], { ...options, exportedAt: '2026-01-02T00:00:00.000Z' })
    expect(fromLive.memories[0]!.context).not.toHaveProperty('loreExportedAt')
    expect(fromFile.memories[0]!.context.loreExportedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(fromFile.memories[0]!.importKey).toBe(fromLive.memories[0]!.importKey)
  })

  describe('计划的指纹', () => {
    const base = (): { plan: ImportPlan; preview: ImportPreview; sync: SyncPlan } => {
      const plan = planImport(
        snapshot(
          node('core://agent/claudecode', { keywords: ['甲乙', '丙丁'], disclosure: '什么时候' }),
          node('infra://token', { aliases: ['infra://old_token'] }),
          node('infra://empty', { content: null }),
        ),
        [
          { slug: 'claude-a', runtimeFamily: 'claudecode', ownerAccountId: ME },
          { slug: 'claude-b', runtimeFamily: 'claudecode', ownerAccountId: ME },
        ],
        options,
      )
      return {
        plan,
        preview: {
          targets: plan.memories.map((item) => ({ item, state: 'new', current: [] })),
          personaExists: false,
          importedPersonas: [],
          appsGivenPersona: [],
          appsOtherPersona: [],
        },
        sync: {
          items: [
            {
              source: 'infra://x',
              uri: 'infra://x',
              state: 'update',
              changes: ['content', 'priority'],
              request: { uri: 'infra://x', expectedVersion: 3, expectedId: 'a' },
            },
            { source: 'infra://y', uri: 'infra://y', state: 'current', changes: [] },
          ],
          goneFromLore: ['infra://b', 'infra://a'],
        },
      }
    }
    const fingerprint = (input: ReturnType<typeof base>) =>
      planFingerprint(input.plan, input.preview, input.sync)
    const same = fingerprint(base())

    it('顺序、版本号、时间与不写入的同步项都不影响', () => {
      const shuffled = base()
      shuffled.plan.apps[0]!.apps.reverse()
      shuffled.plan.skipped.reverse()
      shuffled.plan.warnings.reverse()
      shuffled.preview.targets.reverse()
      shuffled.preview.targets[0]!.item.request.glossary.reverse()
      shuffled.sync.goneFromLore.reverse()
      shuffled.sync.items[0]!.changes.reverse()
      expect(fingerprint(shuffled)).toBe(same)

      const times = base()
      for (const { item } of times.preview.targets) {
        item.createdAt = new Date('2000-01-01T00:00:00Z')
        item.updatedAt = new Date('2000-01-01T00:00:00Z')
        item.context.previousVersions = 99
      }
      times.sync.items[0]!.request = { uri: 'infra://x', expectedVersion: 4, expectedId: 'b' }
      times.sync.items[1]!.state = 'edited'
      times.plan.droppedKeywords.push({ source: 'infra://token', keyword: '词', reason: '不要' })
      expect(fingerprint(times)).toBe(same)
    })

    it('真要写的东西变了就变', () => {
      const changes: ((input: ReturnType<typeof base>) => void)[] = [
        (i) => (i.plan.persona = { slug: 'work', name: '默认人格' }),
        (i) => (i.plan.apps[0]!.apps[0]!.create = true),
        (i) => i.plan.apps[0]!.apps.pop(),
        (i) => (i.preview.targets[0]!.item.source = 'core://agent/other'),
        (i) => (i.preview.targets[0]!.item.request.uri = 'app://claude-c/agent'),
        (i) => (i.preview.targets[0]!.item.request.layer = 'base'),
        (i) => (i.preview.targets[0]!.item.request.priority = 9),
        (i) => (i.preview.targets[0]!.item.request.disclosure = '别的时候'),
        (i) => i.preview.targets[0]!.item.request.glossary.push('新词'),
        (i) => (i.preview.targets[0]!.item.request.content = '别的正文'),
        (i) => (i.preview.targets[0]!.state = 'imported'),
        (i) => i.preview.targets.pop(),
        (i) => i.plan.skipped.pop(),
        (i) => i.plan.warnings.pop(),
        (i) => (i.sync.items[0]!.uri = 'infra://z'),
        (i) => i.sync.items[0]!.changes.pop(),
        (i) => (i.sync.items[0]!.state = 'edited'),
        (i) => i.sync.goneFromLore.pop(),
      ]
      for (const [at, change] of changes.entries()) {
        const input = base()
        change(input)
        expect(fingerprint(input), `第 ${at} 项`).not.toBe(same)
      }
    })
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
      targetApp: null,
      targetPersona: null,
      previousVersions: 4,
    })
    expect(m!.importKey).toBe('projects://kioku@')
  })
})
