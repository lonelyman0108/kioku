import { MAX_CUSTOM_FACET_DIMENSIONS, type AccessContext } from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resolveAccess } from '../../access/access'

type CircleGrantInput = Parameters<typeof resolveAccess>[0]['grants'][number]
import { createPersonalCircle, createSharedCircle } from '../../access/circles'
import { withCircle, type Database, type Db } from '../../db/client'
import { accounts, circles } from '../../db/schema'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { MemoryError } from '../errors'
import {
  aliasMatchesQuery,
  createDimension,
  createTerm,
  deleteDimension,
  deleteTerm,
  ensureProjectTerm,
  evaluateVariantFocus,
  listVocabulary,
  loadCircleVocabularies,
  normalizeProjectSlug,
  scanQueryIntentFlipping,
  synthesizePresenceFocus,
  updateDimension,
  updateTerm,
} from '../facets'

async function seedAccount(db: Db, username: string) {
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'hash' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    return { account: account!, personal }
  })
}

function makeAccess(
  primaryCircleId: string,
  linkedIds: string[] = [],
  context?: Parameters<typeof resolveAccess>[0]['context'],
) {
  const grants: CircleGrantInput[] = [
    {
      circleId: primaryCircleId,
      circleSlug: 'primary-slug',
      circleName: '主圈',
      circleKind: 'personal',
      isPrimary: true,
      mode: 'read_write',
      readKinds: ['entry', 'fact', 'episode'],
      writeKinds: ['entry', 'fact', 'episode'],
      maxSensitivity: context?.chatType ? 'public' : 'private',
      credentials: 'none',
      active: true,
    },
    ...linkedIds.map((id, i) => ({
      circleId: id,
      circleSlug: `linked-${i}`,
      circleName: `客圈-${i}`,
      circleKind: 'shared' as const,
      isPrimary: false,
      mode: 'read' as const,
      readKinds: ['entry' as const, 'fact' as const],
      writeKinds: [],
      maxSensitivity: context?.chatType ? ('public' as const) : ('internal' as const),
      credentials: 'none' as const,
      active: true,
    })),
  ]
  return resolveAccess({
    primaryCircleId,
    grants,
    scopes: {
      readKinds: ['entry', 'fact', 'episode'],
      writeKinds: ['entry', 'fact', 'episode'],
      maxSensitivity: 'private',
      allowedRealms: null,
      admin: false,
      credentials: 'none',
    },
    client: {
      clientId: '00000000-0000-0000-0000-000000000100',
      ownerAccountId: '00000000-0000-0000-0000-000000000200',
      personMemoryMode: 'strict',
    },
    ...(context ? { context } : {}),
  })
}

describe.skipIf(!testDatabaseUrl)('切面词表、蕴含 DAG、焦点合成与提问破壁', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
  })

  afterAll(async () => {
    await database.close()
  })

  it('支持自定义维度、词条 CRUD、自动登记升级以及 DAG 成环与深度超限拒绝', async () => {
    const { personal } = await seedAccount(database.db, 'alice')
    const circleId = personal.id

    await withCircle(database.db, circleId, async (tx) => {
      const initial = await listVocabulary(tx, circleId)
      expect(initial.dimensions.map((d) => d.key)).toEqual(['realm', 'env', 'runtime', 'project'])

      await expect(
        createDimension(tx, circleId, {
          key: 'realm',
          name: '重复内置',
          matchMode: 'exclusive',
          description: null,
        }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

      const roleDim = await createDimension(tx, circleId, {
        key: 'role',
        name: '角色身份',
        matchMode: 'additive',
        description: null,
      })
      expect(roleDim.builtin).toBe(false)
      expect(roleDim.matchMode).toBe('additive')

      const updatedDim = await updateDimension(tx, circleId, 'role', {
        name: '工作角色',
        matchMode: 'exclusive',
      })
      expect(updatedDim.matchMode).toBe('exclusive')

      await createTerm(tx, circleId, {
        dimensionKey: 'realm',
        slug: 'company',
        label: '公司',
        implies: {},
        aliases: ['公司', 'work'],
      })
      const office = await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'office-pc',
        label: '公司主机',
        implies: { realm: ['company'], role: ['dev'] },
        aliases: ['公司电脑'],
      })
      expect(office.implies).toEqual({ realm: ['company'], role: ['dev'] })

      // 被其他词条 implies 引用时禁止删除维度
      await expect(deleteDimension(tx, circleId, 'role')).rejects.toSatisfy(
        (e) => e instanceof MemoryError && e.status === 409,
      )

      // 成环检查：自环与间接环均拒绝
      await expect(
        updateTerm(tx, circleId, office.id, { implies: { env: ['office-pc'] } }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

      await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'relay-a',
        label: '中继 A',
        implies: { env: ['relay-b'] },
        aliases: [],
      })
      const relayB = await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'relay-b',
        label: '中继 B',
        implies: {},
        aliases: [],
      })
      await expect(
        updateTerm(tx, circleId, relayB.id, { implies: { env: ['relay-a'] } }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

      // 蕴含深度允许 4 条边，第 5 条边报错拒绝
      await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'l1',
        label: '一级',
        implies: { env: ['l2'] },
        aliases: [],
      })
      await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'l2',
        label: '二级',
        implies: { env: ['l3'] },
        aliases: [],
      })
      await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'l3',
        label: '三级',
        implies: { env: ['l4'] },
        aliases: [],
      })
      const l4 = await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'l4',
        label: '四级',
        implies: { env: ['l5'] },
        aliases: [],
      })
      await createTerm(tx, circleId, {
        dimensionKey: 'env',
        slug: 'l5',
        label: '五级',
        implies: {},
        aliases: [],
      })
      await expect(
        updateTerm(tx, circleId, l4.id, { implies: { env: ['l5'] } }),
      ).resolves.toMatchObject({ slug: 'l4' })
      await expect(
        createTerm(tx, circleId, {
          dimensionKey: 'env',
          slug: 'l5',
          label: '五级覆盖',
          implies: {},
          aliases: [],
        }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 409)
      await expect(
        createTerm(tx, circleId, {
          dimensionKey: 'env',
          slug: 'l0',
          label: '零级',
          implies: { env: ['l1'] },
          aliases: [],
        }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)

      // 自动登记的 project 可被 createTerm 原地升级
      expect(normalizeProjectSlug({ repoName: 'My Repo!' })).toBe('my-repo')
      const projSlug = await ensureProjectTerm(tx, circleId, { repoName: 'corp-erp' }, true)
      expect(projSlug).toBe('corp-erp')
      const upgraded = await createTerm(tx, circleId, {
        dimensionKey: 'project',
        slug: 'corp-erp',
        label: '企业 ERP',
        implies: { realm: ['company'] },
        aliases: ['公司ERP'],
      })
      expect(upgraded.autoRegistered).toBe(false)
      expect(upgraded.implies).toEqual({ realm: ['company'] })

      // 去掉 role 引用后可删除 role 维度，连同其词条一并清理
      await updateTerm(tx, circleId, office.id, { implies: { realm: ['company'] } })
      await deleteDimension(tx, circleId, 'role')
      await deleteTerm(tx, circleId, office.id)
      const after = await listVocabulary(tx, circleId)
      expect(after.dimensions.some((d) => d.key === 'role')).toBe(false)
    })

    // 自定义维度总数上限校验
    const other = await seedAccount(database.db, 'bob')
    await withCircle(database.db, other.personal.id, async (tx) => {
      for (let i = 0; i < MAX_CUSTOM_FACET_DIMENSIONS; i++) {
        await createDimension(tx, other.personal.id, {
          key: `dim_${i}`,
          name: `自定义${i}`,
          matchMode: 'exclusive',
          description: null,
        })
      }
      await expect(
        createDimension(tx, other.personal.id, {
          key: 'dim_overflow',
          name: '超限',
          matchMode: 'exclusive',
          description: null,
        }),
      ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 400)
    })
  })

  it('精确执行焦点合成顺序（含项目覆盖场域）、ASCII 词边界提问破壁与受限会话屏蔽客场自动项目', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    const teamRes = await createSharedCircle(database.db, {
      name: '研发团队',
      defaultFacets: { realm: ['work'] },
      ownerAccountId: alice.id,
    })
    if (!teamRes.ok) throw new Error('创建共享圈失败')
    const teamId = teamRes.value.id

    await withCircle(database.db, personal.id, async (tx) => {
      await createTerm(tx, personal.id, {
        dimensionKey: 'env',
        slug: 'home-mac',
        label: '家里 Mac',
        implies: { env: ['mac'], realm: ['home'] },
        aliases: ['家里', 'mac'],
      })
      await createTerm(tx, personal.id, {
        dimensionKey: 'project',
        slug: 'corp-erp',
        label: '公司仓库',
        implies: { realm: ['company'] },
        aliases: [],
      })
      await createTerm(tx, personal.id, {
        dimensionKey: 'realm',
        slug: 'ai-lab',
        label: '研究域',
        implies: {},
        aliases: ['ai'],
      })
    })
    await withCircle(database.db, teamId, async (tx) => {
      await ensureProjectTerm(tx, teamId, { repoName: 'secret-client-repo' }, true)
      // 给自动登记的项目词条补充 aliases 以检验受限会话保护
      const vocab = (await loadCircleVocabularies(tx, [teamId])).get(teamId)!
      const autoTerm = vocab.terms.find((t) => t.slug === 'secret-client-repo')!
      await updateTerm(tx, teamId, autoTerm.id, { aliases: ['秘密项目'] })
      await createTerm(tx, teamId, {
        dimensionKey: 'env',
        slug: 'prod',
        label: '生产机房',
        implies: { realm: ['work'] },
        aliases: ['生产环境'],
      })
    })

    // 焦点合成：home-mac 展开 mac+home，但打开 corp-erp 后 realm 被覆盖成 company，保留 env
    const primaryVocab = (
      await withCircle(database.db, personal.id, (tx) => loadCircleVocabularies(tx, [personal.id]))
    ).get(personal.id)!
    const baseFocus = synthesizePresenceFocus({
      contextFacets: { env: ['home-mac'] },
      runtimeFamily: 'claudecode',
      projectSlug: 'corp-erp',
      primaryDefaultFacets: { realm: ['personal'], stage: ['prod'] },
      primaryTerms: primaryVocab.terms,
    })
    expect(baseFocus).toEqual({
      env: ['home-mac', 'mac'],
      project: ['corp-erp'],
      realm: ['company'],
      runtime: ['claudecode'],
      stage: ['prod'],
    })

    // ASCII 词边界校验：ai 只匹配独立词，不匹配 said / mail
    expect(aliasMatchesQuery('how does said work', 'ai')).toBe(false)
    expect(aliasMatchesQuery('use ai tools', 'ai')).toBe(true)

    // 普通本机访问可破壁到客场；受限群聊跳过客场自动登记项目词条
    const bothVocabs = new Map<string, typeof primaryVocab>()
    await withCircle(database.db, personal.id, async (tx) => {
      const m = await loadCircleVocabularies(tx, [personal.id])
      bothVocabs.set(personal.id, m.get(personal.id)!)
    })
    await withCircle(database.db, teamId, async (tx) => {
      const m = await loadCircleVocabularies(tx, [teamId])
      bothVocabs.set(teamId, m.get(teamId)!)
    })

    const unrestricted = makeAccess(personal.id, [teamId])
    const flippedDesktop = scanQueryIntentFlipping(
      '对比 家里 与 生产环境 和 秘密项目',
      baseFocus,
      unrestricted,
      bothVocabs,
    )
    expect(flippedDesktop.queryFocus.realm).toContain('home')
    expect(flippedDesktop.queryFocus.realm).toContain('work')
    expect(flippedDesktop.flippedTerms.map((t) => t.slug)).toContain('secret-client-repo')
    expect(flippedDesktop.flippedCircleIds.has(teamId)).toBe(true)

    const restricted = makeAccess(personal.id, [teamId], {
      chatType: 'group' as Exclude<AccessContext, 'none' | 'owner_direct' | 'direct' | 'cron'>,
      groupSubjectId: '00000000-0000-0000-0000-000000000333',
      senderSubjectId: '00000000-0000-0000-0000-000000000444',
    })
    const flippedGroup = scanQueryIntentFlipping(
      '谈谈 秘密项目 与 生产环境',
      {},
      restricted,
      bothVocabs,
    )
    expect(flippedGroup.flippedTerms.map((t) => t.slug)).toEqual(['prod'])

    // 亲和分计算：命中上限、冲突扣分、客场折减及破壁免扣、跨群印象折减
    const customDims = new Map([['stage', 'additive' as const]])
    const hitEval = evaluateVariantFocus({
      when: { env: ['mac'], runtime: ['claudecode'], stage: ['beta'] },
      circleDefaults: { realm: ['company'] },
      focus: baseFocus,
      customDimensions: customDims,
      awayCircle: true,
      flippedCircle: false,
      flippedRealms: new Set(['company']),
      crossGroup: false,
    })
    // 命中 3 个维（env/runtime/realm）: 0.16*3 + 0.06*2 = 0.60 封顶至 0.28；stage 为 additive 未命中不扣分；company 被 flippedRealms 免除客场折减
    expect(hitEval.kHit).toBe(3)
    expect(hitEval.kConf).toBe(0)
    expect(hitEval.hasConflict).toBe(false)
    expect(hitEval.delta).toBeCloseTo(0.28, 5)

    const conflictAwayEval = evaluateVariantFocus({
      when: { env: ['win'] },
      circleDefaults: { realm: ['work'] },
      focus: baseFocus,
      customDimensions: new Map(),
      awayCircle: true,
      flippedCircle: false,
      flippedRealms: new Set(),
      crossGroup: true,
    })
    // 冲突 2 个排斥维（env, realm）: -0.32; away -0.10; crossGroup -0.06 -> -0.48
    expect(conflictAwayEval.hasConflict).toBe(true)
    expect(conflictAwayEval.delta).toBeCloseTo(-0.48, 5)
  })
})
