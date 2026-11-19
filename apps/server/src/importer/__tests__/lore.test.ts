import { describe, expect, it } from 'vitest'

import {
  assertExecutable,
  credentialHints,
  importKeyOf,
  loreTitle,
  plainSensitivity,
  planFingerprint,
  planImport,
  type CircleRef,
  type ExistingClient,
  type ImportOptions,
  type ImportPlan,
  type ImportPreview,
  type LoreNode,
  type LoreSnapshot,
  type SyncPlan,
} from '../lore'

const ME = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const TARGET_CIRCLE: CircleRef = {
  id: '00000000-0000-4000-8000-000000000010',
  kind: 'shared',
  slug: 'team',
  name: '团队圈',
}
const PERSONAL_CIRCLE: CircleRef = {
  id: '00000000-0000-4000-8000-000000000011',
  kind: 'personal',
  slug: 'alice-personal',
  name: 'alice 的个人圈',
}
const CIRCLES = { target: TARGET_CIRCLE, personal: PERSONAL_CIRCLE }

const BASE_TIME = new Date('2026-01-01T00:00:00Z')
function makeNode(uri: string, extra: Partial<LoreNode> = {}): LoreNode {
  return {
    uuid: `uuid-${uri}`,
    uri,
    aliases: [],
    priority: 2,
    disclosure: null,
    content: `${uri} 的正文`,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    previousVersions: 0,
    keywords: [],
    ...extra,
  }
}

const snapOf = (...nodes: LoreNode[]): LoreSnapshot => ({ nodes, recallEvents: null })

const baseOptions: ImportOptions = {
  accountId: ME,
  persona: { slug: 'default', name: '默认人格' },
  secretUris: new Set(),
}

describe('Lore 导入规划（记忆圈与切面模型）', () => {
  it('按 URI 映射到目标共享圈、个人圈、独立人格与 runtime 切面', () => {
    const plan = planImport(
      snapOf(
        makeNode('core://soul', { content: '# 核心人格\n你是助手' }),
        makeNode('core://soul/style/concise', { content: '简洁回答' }),
        makeNode('core://agent', { priority: 0, content: '# 全局规范\n遵守约定' }),
        makeNode('core://agent/claudecode', { priority: 0, content: 'Claude 运行规范' }),
        makeNode('core://agent/claude_code/tools/bash', { content: 'Shell 工具说明' }),
        makeNode('core://kb/postgres/tuning', { content: '调优指南' }),
        makeNode('preferences://editor/vim', { content: '使用 neovim' }),
        makeNode('infra://docker/host1', { content: '主机配置' }),
        makeNode('persona://old-path', { content: '旧人格路径进入个人圈' }),
      ),
      CIRCLES,
      [],
      baseOptions,
    )

    expect(plan.errors).toEqual([])
    expect(plan.skipped).toEqual([])

    const bySource = new Map(plan.targets.map((t) => [t.source, t]))
    expect(bySource.get('core://soul')).toMatchObject({
      isSoul: true,
      traitKey: 'soul',
      targetCircleId: TARGET_CIRCLE.id,
      boot: true,
      topics: ['soul'],
    })
    expect(bySource.get('core://soul/style/concise')).toMatchObject({
      isSoul: true,
      traitKey: 'style-concise',
      targetCircleId: TARGET_CIRCLE.id,
      boot: true,
    })
    expect(bySource.get('core://agent')).toMatchObject({
      isSoul: false,
      targetCircleId: TARGET_CIRCLE.id,
      targetCircleKind: 'shared',
      sensitivity: 'internal',
      topics: ['agent'],
      when: {},
      boot: true,
    })
    expect(bySource.get('core://agent/claudecode')).toMatchObject({
      isSoul: false,
      targetCircleId: TARGET_CIRCLE.id,
      sensitivity: 'internal',
      topics: ['agent'],
      when: { runtime: ['claudecode'] },
      boot: true,
    })
    expect(bySource.get('core://agent/claude_code/tools/bash')).toMatchObject({
      isSoul: false,
      targetCircleId: TARGET_CIRCLE.id,
      topics: ['agent', 'tools'],
      when: { runtime: ['claude-code'] },
    })
    expect(bySource.get('core://kb/postgres/tuning')).toMatchObject({
      targetCircleId: TARGET_CIRCLE.id,
      sensitivity: 'internal',
      topics: ['kb', 'postgres'],
    })
    expect(bySource.get('preferences://editor/vim')).toMatchObject({
      targetCircleId: PERSONAL_CIRCLE.id,
      targetCircleKind: 'personal',
      sensitivity: 'internal',
      topics: ['preferences', 'editor'],
    })
    expect(bySource.get('infra://docker/host1')).toMatchObject({
      targetCircleId: PERSONAL_CIRCLE.id,
      targetCircleKind: 'personal',
      sensitivity: 'private',
      topics: ['infra', 'docker'],
    })
    expect(bySource.get('persona://old-path')).toMatchObject({
      targetCircleId: PERSONAL_CIRCLE.id,
      sensitivity: 'private',
      topics: ['persona'],
    })
  })

  it('标题取正文首个 # 标题，没有则取来源最后一段；机密只用最后一段', () => {
    expect(loreTitle('# 路由器\n密码 hunter2', 'infra://router', false)).toBe('路由器')
    expect(loreTitle('# 路由器\n密码 hunter2', 'infra://router', true)).toBe('router')
    expect(loreTitle('没有标题的正文', 'infra://router', false)).toBe('router')
    expect(plainSensitivity('preferences://x', 'personal')).toBe('internal')
    expect(plainSensitivity('infra://x', 'personal')).toBe('private')
    expect(plainSensitivity('core://agent', 'shared')).toBe('internal')
  })

  it('接入实例先按 slug 再按 runtimeFamily 匹配本人实例，不写其他成员占用的 slug', () => {
    const existing: ExistingClient[] = [
      {
        id: 'c1',
        slug: 'taken-by-other',
        runtimeFamily: 'other',
        ownerAccountId: OTHER,
        defaultPersonaId: null,
      },
      {
        id: 'c2',
        slug: 'claude-work',
        runtimeFamily: 'claudecode',
        ownerAccountId: ME,
        defaultPersonaId: null,
      },
      {
        id: 'c3',
        slug: 'codex',
        runtimeFamily: 'other',
        ownerAccountId: ME,
        defaultPersonaId: null,
      },
    ]
    const plan = planImport(
      snapOf(
        makeNode('core://agent/claudecode'),
        makeNode('core://agent/codex'),
        makeNode('core://agent/taken-by-other'),
        makeNode('core://agent/zcode'),
      ),
      CIRCLES,
      existing,
      baseOptions,
    )
    const mapByRuntime = new Map(plan.clients.map((m) => [m.runtime, m.clients]))
    expect(mapByRuntime.get('claudecode')).toEqual([
      { slug: 'claude-work', create: false, runtimeFamily: 'claudecode' },
    ])
    expect(mapByRuntime.get('codex')).toEqual([
      { slug: 'codex', create: false, runtimeFamily: 'other' },
    ])
    expect(mapByRuntime.get('zcode')).toEqual([
      { slug: 'zcode', create: true, runtimeFamily: 'other' },
    ])
    expect(plan.skipped).toContainEqual({
      source: 'core://agent/taken-by-other',
      reason: expect.stringContaining('已被其他成员占用'),
    })
  })

  it('去重键按节点与圈/人格计算，别名、空正文、错误占位符、越权占位符均正确处理', () => {
    const k1 = importKeyOf({
      loreNodeUuid: 'n1',
      targetCircleId: TARGET_CIRCLE.id,
      targetPersona: 'default',
    })
    const k2 = importKeyOf({
      loreNodeUuid: 'n1',
      targetCircleId: TARGET_CIRCLE.id,
      targetPersona: 'work',
    })
    expect(k1).not.toBe(k2)

    const plan = planImport(
      snapOf(
        makeNode('infra://secret', {
          aliases: ['infra://secret-alias'],
          content: '# 保密\n内容',
        }),
        makeNode('infra://empty', { content: null }),
        makeNode('infra://bad-ref', { content: '前缀 {{cred:BAD!}} 后缀' }),
        makeNode('core://bad-ref', { content: '共享圈里 {{cred:router#pass}}' }),
        makeNode('preferences://bad-ref', { content: '内部偏好里 {{cred:router#pass}}' }),
        makeNode('infra://ref-in-disc', { disclosure: '看 {{cred:router}}', content: '正文' }),
        makeNode('infra://good-ref', { content: '路由器 {{cred:router#pass}}' }),
      ),
      CIRCLES,
      [],
      {
        ...baseOptions,
        secretUris: new Set(['infra://secret-alias', 'infra://missing-secret']),
        excludeUris: new Set(['infra://missing-exclude']),
      },
    )

    expect(plan.errors).toEqual([
      { kind: 'secretNotFound', uri: 'infra://missing-secret' },
      { kind: 'excludeNotFound', uri: 'infra://missing-exclude' },
    ])
    const targetSecret = plan.targets.find((t) => t.source === 'infra://secret')
    expect(targetSecret).toMatchObject({ sensitivity: 'secret', title: 'secret' })
    expect(plan.targets.find((t) => t.source === 'infra://good-ref')).toBeTruthy()
    expect(plan.skipped.map((s) => s.source)).toEqual(
      expect.arrayContaining([
        'infra://secret-alias',
        'infra://empty',
        'infra://bad-ref',
        'core://bad-ref',
        'preferences://bad-ref',
        'infra://ref-in-disc',
      ]),
    )
    // 默认不向界面报错文本泄露正文里的畸形片段
    expect(plan.skipped.find((s) => s.source === 'infra://bad-ref')!.reason).not.toContain('BAD!')
  })

  it('命令行 quoteMalformed 时附带错误占位符片段；关键词按规则裁剪，截断 disclosure 不拆代理对', () => {
    const emojiDisclosure = `${'长'.repeat(499)}😀尾`
    const keywords = [
      'x',
      'a'.repeat(65),
      '{{cred:wifi}}',
      ...Array.from(
        { length: 35 },
        (_, i) => `kw_${String(i).padStart(2, '0')}_${'z'.repeat(i % 4)}`,
      ),
    ]
    const plan = planImport(
      snapOf(
        makeNode('infra://bad-cli', { content: '含 {{cred:UPPER}}' }),
        makeNode('infra://rich', { disclosure: emojiDisclosure, keywords }),
      ),
      CIRCLES,
      [],
      { ...baseOptions, quoteMalformed: true },
    )
    expect(plan.skipped.find((s) => s.source === 'infra://bad-cli')!.reason).toContain(
      '{{cred:UPPER}}',
    )
    const rich = plan.targets.find((t) => t.source === 'infra://rich')!
    expect(rich.disclosure).toBe('长'.repeat(499))
    expect(rich.glossary).toHaveLength(32)
    expect(plan.droppedKeywords.length).toBeGreaterThanOrEqual(6)
    expect(plan.warnings).toContainEqual({ legacyUri: 'infra://rich', kind: 'disclosureTruncated' })
  })

  it('凭据提示分别检测路径、正文和附加字段（含机密节点的 disclosure 与关键词）', () => {
    const hints = credentialHints(
      makeNode('infra://router_password', {
        content: 'password: my-secret-value',
        disclosure: 'api_key=sk-abcdefghijklmnop',
      }),
    )
    expect(hints).toEqual({ path: true, content: true, extras: true })

    const plan = planImport(
      snapOf(
        makeNode('infra://token_note', {
          content: 'just text',
          disclosure: 'token: abcdefgh123456', // gitleaks:allow
        }),
      ),
      CIRCLES,
      [],
      { ...baseOptions, secretUris: new Set(['infra://token_note']) },
    )
    expect(plan.warnings).toContainEqual({ legacyUri: 'infra://token_note', kind: 'secretExtras' })
  })

  it('勾掉某运行时下全部节点时过滤掉该新建接入实例，全部勾掉什么都不改', () => {
    const mine: ExistingClient[] = [
      {
        id: 'c1',
        slug: 'zcode',
        runtimeFamily: 'other',
        ownerAccountId: ME,
        defaultPersonaId: null,
      },
    ]
    const snap = snapOf(makeNode('core://agent/claudecode'), makeNode('core://agent/zcode'))
    const excludedOne = planImport(snap, CIRCLES, mine, {
      ...baseOptions,
      excludeUris: new Set(['core://agent/claudecode']),
    })
    expect(excludedOne.clients.map((c) => c.runtime)).toEqual(['zcode'])

    const excludedAll = planImport(snap, CIRCLES, mine, {
      ...baseOptions,
      excludeUris: new Set(['core://agent/claudecode', 'core://agent/zcode']),
    })
    expect(excludedAll.clients).toEqual([])
  })

  it('assertExecutable 与 planFingerprint 正确校验错误、主密钥与顺序无关性', () => {
    const snap = snapOf(
      makeNode('core://agent/claudecode', { keywords: ['甲乙', '丙丁'], disclosure: '什么时候' }),
      makeNode('infra://secret'),
    )
    const plan = planImport(snap, CIRCLES, [], {
      ...baseOptions,
      secretUris: new Set(['infra://secret']),
    })
    expect(() => assertExecutable(plan, null)).toThrow('未配置主密钥')
    expect(() => assertExecutable(plan, Buffer.alloc(32))).not.toThrow()

    const badPlan = planImport(snap, CIRCLES, [], {
      ...baseOptions,
      secretUris: new Set(['infra://nope']),
    })
    expect(() => assertExecutable(badPlan, Buffer.alloc(32))).toThrow('infra://nope')

    const makeInputs = (): { plan: ImportPlan; preview: ImportPreview; sync: SyncPlan } => ({
      plan: structuredClone(plan),
      preview: {
        targets: plan.targets.map((item) => ({ item, state: 'new', current: [] })),
        personaExists: false,
        createsPersona: false,
        importedPersonas: [],
        clientsGivenPersona: ['a', 'b'],
        clientsOtherPersona: ['c'],
        newClientsWithPersona: [],
      },
      sync: {
        items: [
          {
            source: 'infra://x',
            legacyUri: 'infra://x',
            shortId: 'm-222222',
            title: 'x',
            state: 'update',
            changes: ['content', 'title'],
          },
        ],
        goneFromLore: ['infra://y'],
      },
    })
    const a = makeInputs()
    const b = makeInputs()
    b.plan.clients.reverse()
    b.preview.targets.reverse()
    b.preview.clientsGivenPersona.reverse()
    b.sync.items[0]!.changes.reverse()
    b.preview.personaExists = true
    expect(planFingerprint(a.plan, a.preview, a.sync)).toBe(
      planFingerprint(b.plan, b.preview, b.sync),
    )

    b.preview.targets[0]!.state = 'imported'
    expect(planFingerprint(a.plan, a.preview, a.sync)).not.toBe(
      planFingerprint(b.plan, b.preview, b.sync),
    )
  })
})
