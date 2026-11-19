import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPersonalCircle, createSharedCircle } from '../../access/circles'
import { confirmBinding, issueCode, normalizeCode, redeemCode } from '../../access/binding'
import { createClient, replaceClientGroupRules, updateClient } from '../../access/clients'
import { ensureConversation } from '../../access/conversations'
import { issueClientKey, rotateClientKey } from '../../access/issue'
import { accessForKey, defaultSession, resolveKeySession } from '../../access/session'
import { principalForKeyId } from '../../auth/middleware'
import { credentialServiceForConsole, credentialServiceForKey } from '../../credential/context'
import { withCircle, type Database, type Db } from '../../db/client'
import {
  EMBEDDING_DIMENSIONS,
  accounts,
  entries,
  entryRecallStats,
  entryVariants,
  facetTerms,
  personaTraits,
  personas,
  recallEventHits,
  recallEvents,
  settings,
  subjectBindings,
  subjectIdentities,
  subjects,
} from '../../db/schema'
import type { Embedder } from '../../embedding/provider'
import { staticEmbedderSource } from '../../embedding/source'
import { embedEntries } from '../../embedding/worker'
import type { Deps } from '../../http/env'
import { lifecycleEvent, recallRequest, whoamiOf } from '../../lifecycle/handlers'
import {
  consoleCircleFor,
  entryServiceForConsole,
  entryServiceForKey,
  recallScopeForKey,
} from '../../memory/context'
import { MemoryError } from '../../memory/errors'
import { createDimension, createTerm } from '../../memory/facets'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { bootPreview, recallDebug } from '../debug'
import { settleRecallEvents } from '../events'

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

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  const vec = Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  // 用若干可读语义主题桶叠加确定性哈希尾数，确保同主题查询与远期记忆即使隔了上百条无关记忆也能精确余弦命中
  const themes: readonly string[] = [
    '咖啡拿铁',
    'typescript后端',
    '家里网络拓扑',
    '双链关联',
    '部署规范',
  ]
  themes.forEach((theme, idx) => {
    if (lower.includes(theme) || [...theme].every((ch) => lower.includes(ch))) {
      vec[idx] = 4
    }
  })
  const digest = createHash('sha256').update(text).digest()
  for (let i = themes.length; i < EMBEDDING_DIMENSIONS; i++) {
    vec[i] = ((digest[i % digest.length]! - 128) / 128) * 0.05
  }
  const norm = Math.hypot(...vec) || 1
  return vec.map((v) => v / norm)
}

function deterministicEmbedder(model = 'presence-embed'): Embedder {
  return {
    model,
    async embed(texts) {
      return texts.map((t) => vectorFor(t))
    },
  }
}

function makeDeps(db: Db, embedder: Embedder | null = null): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey: Buffer.alloc(32, 5),
    embedder: staticEmbedderSource(embedder),
    jobs: null,
  }
}

const READ_WRITE_ALL = {
  readKinds: ['entry', 'fact', 'episode'] as ('entry' | 'fact' | 'episode')[],
  writeKinds: ['entry', 'fact', 'episode'] as ('entry' | 'fact' | 'episode')[],
  maxSensitivity: 'secret' as const,
  credentials: 'manage' as const,
  allowedRealms: null,
  admin: false,
}

describe.skipIf(!testDatabaseUrl)(
  '切面存在感引擎、主客场编译、双链扩散与多群机器人双模式端到端测试',
  () => {
    let database: Database

    beforeAll(async () => {
      database = await openTestDatabase()
    })

    beforeEach(async () => {
      await settleRecallEvents()
      await resetDatabase(database)
      await database.db.delete(settings)
    })

    afterEach(async () => {
      await settleRecallEvents()
    })

    afterAll(async () => {
      await database.close()
    })

    it('完成同机跨场域启动编译与原子预算、提问破壁与噪声拦截、主客场个人穿透及 1 跳安全双链扩散', async () => {
      const { account: alice, personal } = await seedAccount(database.db, 'alice')
      const teamRes = await createSharedCircle(database.db, {
        name: '研发共享圈',
        defaultFacets: { realm: ['work'] },
        ownerAccountId: alice.id,
      })
      if (!teamRes.ok) throw new Error('建共享圈失败')
      const teamCircleId = teamRes.value.id

      const embedder = deterministicEmbedder()
      const deps = makeDeps(database.db, embedder)

      // 配置个人圈词表与独立人格继承链（子人格按 traitKey 覆盖父人格）
      let childPersonaId = ''
      await withCircle(database.db, personal.id, async (tx) => {
        await createDimension(tx, personal.id, {
          key: 'stage',
          name: '部署阶段',
          matchMode: 'exclusive',
          description: null,
        })
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
          label: '公司 ERP',
          implies: { realm: ['company'] },
          aliases: [],
        })

        const [basePersona] = await tx
          .insert(personas)
          .values({ circleId: personal.id, slug: 'base', name: '基础人格' })
          .returning()
        const [childPersona] = await tx
          .insert(personas)
          .values({
            circleId: personal.id,
            slug: 'coder',
            name: '研发搭档',
            extendsId: basePersona!.id,
          })
          .returning()
        childPersonaId = childPersona!.id
        await tx.insert(personaTraits).values([
          {
            circleId: personal.id,
            personaId: basePersona!.id,
            traitKey: 'role',
            title: '定位',
            content: '你是长期协同开发助手。',
            sortOrder: 0,
          },
          {
            circleId: personal.id,
            personaId: basePersona!.id,
            traitKey: 'tone',
            title: '口吻',
            content: '默认稳重。',
            sortOrder: 1,
          },
          {
            circleId: personal.id,
            personaId: childPersona!.id,
            traitKey: 'tone',
            title: '口吻',
            content: '精炼直接，给出可执行结论。',
            sortOrder: 1,
          },
        ])
      })

      // 在个人圈与共享圈写入多变体词条、双链目标、优先级 0 穿透词条与互斥干扰切片
      const personalSvc = await entryServiceForConsole(deps, personal.id, alice.id)
      const teamSvc = await entryServiceForConsole(deps, teamCircleId, alice.id)
      void teamSvc

      const gitGuide = await personalSvc.create({
        title: 'Git 提交与工作流规范',
        priority: 0,
        variants: [
          { when: {}, content: '通用规范：提交前先跑格式化与单元测试。', sortOrder: 0 },
          { when: { realm: ['home'] }, content: '家里个人项目可直接推送个人仓库。', sortOrder: 1 },
          { when: { realm: ['company'] }, content: '公司项目必须经 PR 门禁合并。', sortOrder: 2 },
          { when: { env: ['mac'] }, content: 'mac 上统一使用 pnpm 包管理器。', sortOrder: 3 },
        ],
      })

      // 用于验证原子预算 omitted（优先级靠后但较长）
      const longRule = await personalSvc.create({
        title: '长篇代码审查清单',
        priority: 0,
        content: '详尽审查条目：'.repeat(30),
      })

      // 未标 realm 的个人通用偏好（供共享圈为主场时穿透到 boot）
      const codingHabit = await personalSvc.create({
        title: '代码风格习惯',
        priority: 0,
        content: '优先使用早返回与纯函数。',
      })
      // 明确标了 realm: ['home'] 的个人圈词条（共享圈主场的 boot 不应穿透）
      const homeRoutine = await personalSvc.create({
        title: '家里作息习惯',
        priority: 0,
        variants: [{ when: { realm: ['home'] }, content: '晚上十一点关闭通知。', sortOrder: 0 }],
      })

      // 双链测试：合法可读邻居（非机密、非冲突）、被剥离冲突切片上的出链（不能扩散）、机密邻居（不能泄露）
      const secretNeighbor = await personalSvc.create({
        title: '路由器管理密码',
        sensitivity: 'secret',
        variants: [{ when: { realm: ['home'] }, content: 'router-pass-9999', sortOrder: 0 }],
      })
      const safeNeighbor = await personalSvc.create({
        title: 'NAS 链路聚合配置',
        priority: 1,
        variants: [
          {
            when: { realm: ['home'] },
            content: '主 NAS 设备位于 10.0.0.20 并开启双网口链路聚合。',
            sortOrder: 0,
          },
        ],
      })
      const leakedNeighbor = await personalSvc.create({
        title: 'Windows 注册表兼容脚本',
        variants: [{ when: { env: ['win'] }, content: 'win 专用注册表项。', sortOrder: 0 }],
      })
      const homeNetEntry = await personalSvc.create({
        title: '家里网络拓扑说明',
        variants: [
          {
            when: { realm: ['home'] },
            content: `在家访问 家里网络拓扑 请直连内网，参见 [[${safeNeighbor.shortId}]] 与机密 [[${secretNeighbor.shortId}]]。`,
            sortOrder: 0,
          },
          {
            when: { env: ['win'] },
            content: `仅 win 分支参考 [[${leakedNeighbor.shortId}]]。`,
            sortOrder: 1,
          },
        ],
      })
      // 无关噪声词条：标了 company+mac 切面但不包含查询关键词，用于验证 relevanceFloor 拦截
      const noiseEntry = await personalSvc.create({
        title: '行政报销单据日期',
        variants: [
          {
            when: { realm: ['company'], env: ['mac'] },
            content: '每月二十五号前递交纸质发票给财务。',
            sortOrder: 0,
          },
        ],
      })

      // 签发两把钥匙：个人为主场、研发共享圈为主场
      const issued = await withCircle(database.db, personal.id, async (tx) => {
        const cRes = await createClient(tx, {
          circleId: personal.id,
          ownerAccountId: alice.id,
          slug: 'home-mac-cli',
          name: '家里 Mac Claude',
          runtimeFamily: 'claudecode',
          defaultPersonaId: childPersonaId,
        })
        if (!cRes.ok) throw new Error('建接入实例失败')
        const kRes = await issueClientKey(tx, {
          circleId: personal.id,
          clientId: cRes.client.id,
          accountId: alice.id,
          name: '家里 Mac 钥匙',
          linkedCircles: [{ circleId: teamCircleId, mode: 'read' }],
          contextFacets: { env: ['home-mac'] },
          scopes: READ_WRITE_ALL,
        })
        if (!kRes.ok) throw new Error('签发密钥失败')
        return kRes
      })

      const teamIssued = await withCircle(database.db, teamCircleId, async (tx) => {
        const cRes = await createClient(tx, {
          circleId: teamCircleId,
          ownerAccountId: alice.id,
          slug: 'team-cli',
          name: '团队工位端',
          runtimeFamily: 'claudecode',
        })
        if (!cRes.ok) throw new Error('建团队接入实例失败')
        const kRes = await issueClientKey(tx, {
          circleId: teamCircleId,
          clientId: cRes.client.id,
          accountId: alice.id,
          name: '团队工位钥匙',
          linkedCircles: [{ circleId: personal.id, mode: 'read' }],
          contextFacets: { realm: ['work'] },
          scopes: { ...READ_WRITE_ALL, maxSensitivity: 'private' },
        })
        if (!kRes.ok) throw new Error('签发团队密钥失败')
        return kRes
      })

      const personalPrincipal = (await principalForKeyId(database.db, issued.row.id))!
      const teamPrincipal = (await principalForKeyId(database.db, teamIssued.row.id))!
      const scope = recallScopeForKey(deps, personalPrincipal, defaultSession(personalPrincipal), {
        project: { repoName: 'corp-erp' },
      })

      // 验证焦点合成：env 含 home-mac/mac，project 为 corp-erp，且 realm 被项目覆盖成 company
      const focus = await scope.focus()
      expect(focus).toEqual({
        env: ['home-mac', 'mac'],
        project: ['corp-erp'],
        realm: ['company'],
        runtime: ['claudecode'],
      })

      // 1) 启动编译：persona_traits 在前（仅合并后两条），Git 规范合并通用 + company + mac（剔除 home 冲突切片），长篇清单因超预算整体进入 omitted
      const fullBoot = await scope.boot(4000)
      expect(fullBoot.personaTraits.map((t) => [t.traitKey, t.content])).toEqual([
        ['role', '你是长期协同开发助手。'],
        ['tone', '精炼直接，给出可执行结论。'],
      ])
      const gitCompiled = fullBoot.entries.find((e) => e.shortId === gitGuide.shortId)!
      expect(gitCompiled.content).toContain('提交前先跑格式化与单元测试')
      expect(gitCompiled.content).toContain('公司项目必须经 PR 门禁合并')
      expect(gitCompiled.content).toContain('mac 上统一使用 pnpm 包管理器')
      expect(gitCompiled.content).not.toContain('直接推送个人仓库')

      // 紧缩预算测试整条原子预算：只能放下 gitGuide，longRule 不允许只展开一半，必须整条进 omitted
      const baseWithoutLong =
        fullBoot.personaTraits.map((t) => `## ${t.title}\n\n${t.content}`).join('\n\n').length +
        2 +
        gitCompiled.content.length +
        gitGuide.title.length +
        20
      const tightBoot = await scope.boot(baseWithoutLong + 40)
      expect(tightBoot.entries.map((e) => e.shortId)).toContain(gitGuide.shortId)
      expect(tightBoot.entries.map((e) => e.shortId)).not.toContain(longRule.shortId)
      expect(tightBoot.omitted).toContain(longRule.shortId)

      // 3) 共享圈为主场 + 个人圈为关联客场：仅个人圈未标 realm 的 priority = 0 词条（codingHabit）穿透，homeRoutine 不进 boot
      const teamScope = recallScopeForKey(deps, teamPrincipal, defaultSession(teamPrincipal))
      const teamBoot = await teamScope.boot(4000)
      expect(teamBoot.entries.map((e) => e.shortId)).toContain(codingHabit.shortId)
      expect(teamBoot.entries.map((e) => e.shortId)).not.toContain(homeRoutine.shortId)
      expect(teamBoot.entries.map((e) => e.shortId)).not.toContain(gitGuide.shortId)

      const conflictSeedTarget = await personalSvc.create({
        title: '冲突种子独有邻居',
        variants: [{ when: {}, content: '绝不应经冲突种子扩散出来的普通词条。', sortOrder: 0 }],
      })
      const conflictingSeed = await personalSvc.create({
        title: '仅 Win 有效的家里网络拓扑种子',
        variants: [
          {
            when: { env: ['win'] },
            content: `仅 win 环境下提及 家里网络拓扑 与 [[${conflictSeedTarget.shortId}]]。`,
            sortOrder: 0,
          },
        ],
      })

      // 2 + 4) 嵌入后执行提问破壁召回 + 1 跳安全双链扩散
      await embedEntries(database.db, embedder, personal.id, [
        homeNetEntry.id,
        safeNeighbor.id,
        leakedNeighbor.id,
        noiseEntry.id,
        gitGuide.id,
        conflictSeedTarget.id,
        conflictingSeed.id,
      ])
      void teamSvc

      // 无「家里」触发词时，不发生破壁；含「家里」触发词时，破壁并入 home 场域，命中 homeNetEntry 并从无冲突切片扩散到 safeNeighbor，
      // 绝不从已被剥离的 win 切片扩散到 leakedNeighbor，全部切片均冲突的种子亦不回退扩散到 conflictSeedTarget，也绝不泄露 secretNeighbor；relevanceFloor 挡掉无关 noiseEntry
      const flippedHits = await scope.recall('家里网络拓扑', {
        limit: 10,
        minScore: 0.1,
      })
      const netHit = flippedHits.find((h) => h.shortId === homeNetEntry.shortId)
      expect(netHit).toBeDefined()
      expect(netHit!.matchedWhen).toEqual({ realm: ['home'] })

      const neighborHit = flippedHits.find((h) => h.shortId === safeNeighbor.shortId)
      expect(neighborHit).toBeDefined()
      expect(neighborHit!.via).toContain('link')
      expect(neighborHit!.cues.some((c) => c.includes(homeNetEntry.shortId))).toBe(true)

      expect(flippedHits.some((h) => h.shortId === leakedNeighbor.shortId)).toBe(false)
      expect(flippedHits.some((h) => h.shortId === conflictSeedTarget.shortId)).toBe(false)
      expect(flippedHits.some((h) => h.shortId === secretNeighbor.shortId)).toBe(false)
      expect(flippedHits.some((h) => h.shortId === noiseEntry.shortId)).toBe(false)

      // 验证召回调试 recallDebug 返回 resolvedFacets 与 flippedTerms，以及 bootPreview 返回结构
      const memberCtx = (await consoleCircleFor(deps, alice.id, personal.id))!
      const debugRes = await recallDebug(
        deps,
        personalPrincipal,
        memberCtx.access,
        { query: '家里网络拓扑', crossCircle: true },
        { project: { repoName: 'corp-erp' } },
      )
      expect(debugRes.flippedTerms.some((t) => t.slug === 'home-mac')).toBe(true)
      expect(debugRes.resolvedFacets.realm).toEqual(['company', 'home'])
      expect(debugRes.filtered.some((f) => f.shortId === secretNeighbor.shortId)).toBe(false)

      const previewRes = await bootPreview(deps, personalPrincipal, {
        project: { repoName: 'corp-erp' },
      })
      expect(previewRes.resolvedFacets.realm).toEqual(['company'])
      expect(previewRes.personaTraits).toHaveLength(2)
    })

    it('强制执行机密词条与凭据静态双向场域锁：project/facets/破壁与会话均不可越权突破 404', async () => {
      const { account: alice, personal } = await seedAccount(database.db, 'alice')
      const teamRes = await createSharedCircle(database.db, {
        name: '外包共享圈',
        defaultFacets: { realm: ['work'] },
        ownerAccountId: alice.id,
      })
      if (!teamRes.ok) throw new Error('建共享圈失败')
      const teamCircleId = teamRes.value.id

      const deps = makeDeps(database.db)
      const personalSvc = await entryServiceForConsole(deps, personal.id, alice.id)
      const teamSvc = await entryServiceForConsole(deps, teamCircleId, alice.id)
      void teamSvc

      await withCircle(database.db, personal.id, async (tx) => {
        await createTerm(tx, personal.id, {
          dimensionKey: 'env',
          slug: 'office-pc',
          label: '公司电脑',
          implies: { env: ['win'], realm: ['company'] },
          aliases: ['公司电脑'],
        })
        await createTerm(tx, personal.id, {
          dimensionKey: 'project',
          slug: 'side-project',
          label: '个人副业',
          implies: { realm: ['personal'] },
          aliases: ['副业'],
        })
      })

      // 新建各场域机密词条与受限凭据
      const homeSecret = await personalSvc.create({
        title: '家里路由器根密',
        sensitivity: 'secret',
        variants: [{ when: { realm: ['home'] }, content: 'home-secret-val', sortOrder: 0 }],
      })
      const companySecret = await personalSvc.create({
        title: '公司服务器私钥',
        sensitivity: 'secret',
        variants: [{ when: { realm: ['company'] }, content: 'company-secret-val', sortOrder: 0 }],
      })
      const awaySecret = await teamSvc.create({
        title: '共享圈机密凭据说明',
        sensitivity: 'secret',
        variants: [{ when: { realm: ['work'] }, content: 'away-secret-val', sortOrder: 0 }],
      })

      const personalCredSvc = await credentialServiceForConsole(deps, personal.id, alice.id)
      await personalCredSvc.create({
        identifier: 'home-cred',
        name: '家里凭据',
        allowedRealms: ['home'],
        source: { kind: 'new', values: { token: 'home-tok-1' } },
      })
      await personalCredSvc.create({
        identifier: 'unmarked-cred',
        name: '未标场域个人凭据',
        source: { kind: 'new', values: { token: 'demo-val' } },
      })
      await personalCredSvc.create({
        identifier: 'company-cred',
        name: '公司凭据',
        allowedRealms: ['company'],
        source: { kind: 'new', values: { token: 'company-tok-3' } },
      })

      // 签发静态锁定为 company 场域（office-pc）的钥匙
      const issued = await withCircle(database.db, personal.id, async (tx) => {
        const cRes = await createClient(tx, {
          circleId: personal.id,
          ownerAccountId: alice.id,
          slug: 'office-win',
          name: '工位 Windows',
          runtimeFamily: 'claudecode',
        })
        if (!cRes.ok) throw new Error('建实例失败')
        const kRes = await issueClientKey(tx, {
          circleId: personal.id,
          clientId: cRes.client.id,
          accountId: alice.id,
          name: '公司受限白名单密钥',
          linkedCircles: [{ circleId: teamCircleId, mode: 'read' }],
          contextFacets: { env: ['office-pc'] },
          scopes: {
            ...READ_WRITE_ALL,
            allowedRealms: ['company'],
          },
        })
        if (!kRes.ok) throw new Error('签发密钥失败')
        return kRes
      })

      const principal = (await principalForKeyId(database.db, issued.row.id))!
      const keyEntries = entryServiceForKey(deps, principal, defaultSession(principal))
      const keyCreds = credentialServiceForKey(deps, principal, defaultSession(principal))

      // 即使在会话动态打开 side-project（焦点 realm -> personal），静态双向场域锁依然严格生效：
      const dynamicScope = recallScopeForKey(deps, principal, defaultSession(principal), {
        project: { repoName: 'side-project' },
      })
      expect((await dynamicScope.focus()).realm).toEqual(['personal'])

      // 1) company-secret 与 company-cred 允许读取
      const okSecret = await keyEntries.get({ id: companySecret.shortId })
      expect(okSecret.variants[0]?.content).toBe('company-secret-val')
      const okCred = await keyCreds.use('company-cred', 'token', 'kioku_credential', '单元测试')
      expect(okCred.values?.token).toBe('company-tok-3')

      // 2) homeSecret（场域冲突）、unmarked-cred（密钥白名单拦截未标 realm 个人凭据）、home-cred 与 awaySecret（客场圈）一律 404
      for (const blockedId of [homeSecret.shortId, awaySecret.shortId]) {
        await expect(keyEntries.get({ id: blockedId })).rejects.toSatisfy(
          (e) => e instanceof MemoryError && e.status === 404,
        )
      }
      for (const blockedCred of ['home-cred', 'unmarked-cred']) {
        await expect(
          keyCreds.use(blockedCred, 'token', 'kioku_credential', '越权'),
        ).rejects.toSatisfy((e) => e instanceof MemoryError && e.status === 404)
      }

      // 3) 即使处于受限群聊，机密词条硬拒绝 404，凭据硬拒绝 403（包括原本在本机能读的 companySecret 与 company-cred）
      const groupSession = await resolveKeySession(deps, principal, {
        chatType: 'group',
        platform: 'qq',
        group: { id: 'g-sec', name: '安全测试群' },
        sender: { id: 'u-sec', name: '群友' },
      })
      const groupEntries = entryServiceForKey(deps, principal, groupSession)
      const groupCreds = credentialServiceForKey(deps, principal, groupSession)
      await expect(groupEntries.get({ id: companySecret.shortId })).rejects.toSatisfy(
        (e) => e instanceof MemoryError && e.status === 404,
      )
      await expect(groupCreds.use('company-cred', 'token', 'kioku_credential')).rejects.toSatisfy(
        (e) => e instanceof MemoryError && e.status === 403,
      )
    })

    it('支持 strict 强隔离与 persona_shared 跨群识人、单群隔离锁、多机器人防串群、远期事实语义召回与近 3 条摘要注入', async () => {
      const { account: alice, personal } = await seedAccount(database.db, 'alice')
      const embedder = deterministicEmbedder()
      const deps = makeDeps(database.db, embedder)

      const personalSvc = await entryServiceForConsole(deps, personal.id, alice.id)
      const ownerPrivate = await personalSvc.create({
        title: '所有者私人账号密码习惯',
        sensitivity: 'private',
        content: '主人日常私密工作流备忘。',
      })
      const ownerInternal = await personalSvc.create({
        title: '内部团队研发排期',
        sensitivity: 'internal',
        content: '内部排期：周四发版。',
      })

      // 额外关联个人/共享客场圈以验证受限会话屏蔽客场 slug/name 与客场 autoRegistered project 词条
      const guestRes = await createSharedCircle(database.db, {
        name: '私有内部项目圈',
        ownerAccountId: alice.id,
      })
      if (!guestRes.ok) throw new Error('建客场圈失败')
      const guestCircleId = guestRes.value.id
      await withCircle(database.db, guestCircleId, async (tx) => {
        await tx.insert(facetTerms).values({
          circleId: guestCircleId,
          dimensionKey: 'project',
          slug: 'hidden-secret-repo',
          label: '保密仓库',
          implies: {},
          aliases: [],
          autoRegistered: true,
        })
      })
      await withCircle(database.db, personal.id, async (tx) => {
        await createDimension(tx, personal.id, {
          key: 'domain_tag',
          name: '领域标签中文名',
          matchMode: 'additive',
          description: null,
        })
      })

      const { botKey, otherBotKey } = await withCircle(database.db, personal.id, async (tx) => {
        const b1 = await createClient(tx, {
          circleId: personal.id,
          ownerAccountId: alice.id,
          slug: 'astrbot-main',
          name: '主力聊天机器人',
          runtimeFamily: 'astrbot',
        })
        const b2 = await createClient(tx, {
          circleId: personal.id,
          ownerAccountId: alice.id,
          slug: 'astrbot-other',
          name: '另一只同圈机器人',
          runtimeFamily: 'astrbot',
        })
        if (!b1.ok || !b2.ok) throw new Error('建机器人失败')
        const k1 = await issueClientKey(tx, {
          circleId: personal.id,
          clientId: b1.client.id,
          accountId: alice.id,
          name: '主力机器人密钥',
          linkedCircles: [{ circleId: guestCircleId, mode: 'read' }],
          scopes: READ_WRITE_ALL,
        })
        const k2 = await issueClientKey(tx, {
          circleId: personal.id,
          clientId: b2.client.id,
          accountId: alice.id,
          name: '另一机器人密钥',
          scopes: READ_WRITE_ALL,
        })
        if (!k1.ok || !k2.ok) throw new Error('签发密钥失败')
        return { botKey: k1, otherBotKey: k2 }
      })

      const principal1 = (await principalForKeyId(database.db, botKey.row.id))!
      const principal2 = (await principalForKeyId(database.db, otherBotKey.row.id))!

      // 建两个群（甲群、乙群）及同一个跨群人物（张三）+ 另一群友私聊，写入事实（含超过 8 条直连上限后的远期咖啡拿铁事实）
      const groupACtx = {
        chatType: 'group' as const,
        platform: 'qq',
        group: { id: 'grp-alpha', name: '甲群' },
        sender: { id: 'person-zhangsan', name: '张三' },
      }
      const groupBCtx = {
        chatType: 'group' as const,
        platform: 'qq',
        group: { id: 'grp-beta', name: '乙群' },
        sender: { id: 'person-zhangsan', name: '张三' },
      }
      const dmCtx = {
        chatType: 'direct' as const,
        platform: 'qq',
        sender: { id: 'person-zhangsan', name: '张三' },
      }
      const sessionA = await resolveKeySession(deps, principal1, groupACtx)
      const sessionB = await resolveKeySession(deps, principal1, groupBCtx)
      await resolveKeySession(deps, principal1, dmCtx)
      const otherBotSessionA = await resolveKeySession(deps, principal2, groupACtx)

      const gAId = sessionA.context.groupSubjectId!
      const gBId = sessionB.context.groupSubjectId!
      const zhangsanId = sessionA.context.senderSubjectId!
      const scopeA = `group:${gAId}`
      const scopeDM = `direct:${zhangsanId}`

      const factIdsToEmbed: string[] = []
      await withCircle(database.db, personal.id, async (tx) => {
        const convA = await ensureConversation(tx, personal.id, botKey.client.id, {
          kind: 'group',
          subjectId: gAId,
        })
        const convOtherA = await ensureConversation(tx, personal.id, otherBotKey.client.id, {
          kind: 'group',
          subjectId: gAId,
        })
        const convB = await ensureConversation(tx, personal.id, botKey.client.id, {
          kind: 'group',
          subjectId: gBId,
        })
        const convDM = await ensureConversation(tx, personal.id, botKey.client.id, {
          kind: 'direct',
          subjectId: zhangsanId,
        })

        const insertFact = async (opts: {
          shortId: string
          clientId: string
          subjectId: string
          subjectKind: 'person' | 'group'
          conversationId: string
          originScope: string
          content: string
          createdAt: Date
        }) => {
          const [e] = await tx
            .insert(entries)
            .values({
              circleId: personal.id,
              circleKind: 'personal',
              shortId: opts.shortId,
              kind: 'fact',
              clientId: opts.clientId,
              subjectId: opts.subjectId,
              subjectKind: opts.subjectKind,
              conversationId: opts.conversationId,
              provenance: 'untrusted',
              originScope: opts.originScope,
              title: opts.content.slice(0, 30),
              sensitivity: 'public',
              priority: 2,
              createdAt: opts.createdAt,
              updatedAt: opts.createdAt,
            })
            .returning()
          await tx.insert(entryVariants).values({
            circleId: personal.id,
            entryId: e!.id,
            kind: 'fact',
            sensitivity: 'public',
            when: {},
            whenSignature: '{}',
            sortOrder: 0,
            content: opts.content,
            searchHeader: opts.content.slice(0, 30),
          })
          factIdsToEmbed.push(e!.id)
          return e!
        }

        // 远期事实（10 条前写成，超过 recall.subjectFacts = 8 限制）：张三在甲群提到爱喝 咖啡拿铁
        const oldTime = new Date(Date.now() - 86_400_000 * 30)
        await insertFact({
          shortId: 'm-2222aa',
          clientId: botKey.client.id,
          subjectId: zhangsanId,
          subjectKind: 'person',
          conversationId: convA,
          originScope: scopeA,
          content: '远期记录：非常喜欢喝现磨冰美式和咖啡拿铁。',
          createdAt: oldTime,
        })
        // 补 9 条较新琐碎事实把上述远期事实挤出直连 8 条窗口
        const padLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'j']
        for (let i = 0; i < 9; i++) {
          await insertFact({
            shortId: `m-2222b${padLetters[i]}`,
            clientId: botKey.client.id,
            subjectId: zhangsanId,
            subjectKind: 'person',
            conversationId: convA,
            originScope: scopeA,
            content: `日常近况琐事第 ${i + 2} 项记录。`,
            createdAt: new Date(Date.now() - 86_400_000 * (9 - i)),
          })
        }
        // 同群的群自身事实（绝不跨群）
        await insertFact({
          shortId: 'm-2222ca',
          clientId: botKey.client.id,
          subjectId: gAId,
          subjectKind: 'group',
          conversationId: convA,
          originScope: scopeA,
          content: '甲群固定在每周五晚上线上桌游。',
          createdAt: new Date(),
        })
        // 私聊事实（绝不跨群）
        await insertFact({
          shortId: 'm-2222da',
          clientId: botKey.client.id,
          subjectId: zhangsanId,
          subjectKind: 'person',
          conversationId: convDM,
          originScope: scopeDM,
          content: '张三在私聊里单独托付的个人秘密事。',
          createdAt: new Date(),
        })
        // 同圈另一机器人写入的甲群事实（绝不能被主力机器人跨群读到）
        await insertFact({
          shortId: 'm-2222ea',
          clientId: otherBotKey.client.id,
          subjectId: zhangsanId,
          subjectKind: 'person',
          conversationId: convOtherA,
          originScope: scopeA,
          content: '另一机器人单独记录：张三擅长滑雪和咖啡拿铁。',
          createdAt: new Date(),
        })

        // 为乙群写入 4 条 untrusted 会话摘要，验证 session.start 只取最近 3 条并包含在 context 中
        const epLetters = ['a', 'b', 'c', 'd']
        for (let i = 1; i <= 4; i++) {
          const ts = new Date(Date.now() - (5 - i) * 60_000)
          const [ep] = await tx
            .insert(entries)
            .values({
              circleId: personal.id,
              circleKind: 'personal',
              shortId: `m-2222f${epLetters[i - 1]}`,
              kind: 'episode',
              clientId: botKey.client.id,
              conversationId: convB,
              provenance: 'untrusted',
              originScope: `group:${gBId}`,
              title: `乙群摘要${i}`,
              sensitivity: 'public',
              priority: 2,
              createdAt: ts,
              updatedAt: ts,
            })
            .returning()
          await tx.insert(entryVariants).values({
            circleId: personal.id,
            entryId: ep!.id,
            kind: 'episode',
            sensitivity: 'public',
            when: {},
            whenSignature: '{}',
            sortOrder: 0,
            content: `乙群第${i}轮讨论概要。`,
            searchHeader: `乙群摘要${i}`,
          })
        }
        void otherBotSessionA
      })

      await embedEntries(database.db, embedder, personal.id, factIdsToEmbed)

      // 1. 强隔离 strict 模式：在乙群、私聊里均查不到甲群个人事实；群聊隐藏客场标识与客场 autoRegistered project 词条，本人 private/internal 不可见
      const whoamiGroup = await whoamiOf(deps, principal1, { context: groupBCtx })
      expect(whoamiGroup.linkedCircles[0]).toMatchObject({
        id: guestCircleId,
        slug: null,
        name: null,
      })
      expect(whoamiGroup.vocabulary.find((d) => d.key === 'domain_tag')?.name).toBe(
        '领域标签中文名',
      )
      expect(
        whoamiGroup.vocabulary.find((d) => d.key === 'project')?.terms.map((t) => t.slug),
      ).not.toContain('hidden-secret-repo')

      const strictGroupB = await recallScopeForKey(deps, principal1, sessionB).recall('咖啡拿铁', {
        limit: 10,
        minScore: 0.1,
      })
      expect(strictGroupB).toHaveLength(0)

      const strictTurnB = await lifecycleEvent(
        deps,
        principal1,
        {
          event: 'prompt.submit',
          sessionId: 'b-strict',
          context: groupBCtx,
          prompt: '主人私人工作流',
        },
        (s, o) => recallScopeForKey(deps, principal1, s, o),
      )
      expect(strictTurnB.shortIds).not.toContain(ownerPrivate.shortId)
      expect(strictTurnB.shortIds).not.toContain(ownerInternal.shortId)

      // 验证群聊 session.start 注入最近 3 条（最新第 2/3/4 条，不含第 1 条）untrusted 会话摘要
      const startB = await lifecycleEvent(
        deps,
        principal1,
        { event: 'session.start', sessionId: 'b-start', context: groupBCtx },
        (s, o) => recallScopeForKey(deps, principal1, s, o),
      )
      const startText = JSON.stringify(startB.hostOutput.value)
      expect(startText).toContain('乙群第4轮讨论概要')
      expect(startText).not.toContain('乙群第1轮讨论概要')

      // 2. 切换拟人模式 persona_shared：立刻在乙群与私聊看到甲群（同 client）远期咖啡拿铁与近况，带 [其他群印象] 标注；
      //    但私聊秘密、甲群群自身事实、同圈另一机器人事实绝不跨群
      await withCircle(database.db, personal.id, (tx) =>
        updateClient(tx, {
          circleId: personal.id,
          clientId: botKey.client.id,
          config: { personMemoryMode: 'persona_shared' },
        }),
      )
      const sharedPrincipal = (await principalForKeyId(database.db, botKey.row.id))!
      const sharedPromptB = await lifecycleEvent(
        deps,
        sharedPrincipal,
        {
          event: 'prompt.submit',
          sessionId: 'b-shared',
          context: groupBCtx,
          prompt: '喝什么咖啡拿铁好呢',
        },
        (s, o) => recallScopeForKey(deps, sharedPrincipal, s, o),
      )
      expect(sharedPromptB.shortIds).toContain('m-2222aa')
      expect(sharedPromptB.shortIds).not.toContain('m-2222ca')
      expect(sharedPromptB.shortIds).not.toContain('m-2222da')
      expect(sharedPromptB.shortIds).not.toContain('m-2222ea')
      expect(JSON.stringify(sharedPromptB.hostOutput.value)).toContain('[其他群印象]')

      // 拟人模式下，在私聊会话也可读到甲群跨群印象与该人本私聊事实
      const sharedSessionDM = await resolveKeySession(deps, sharedPrincipal, dmCtx)
      const dmSubjects = await recallScopeForKey(deps, sharedPrincipal, sharedSessionDM).subjects()
      const dmFacts = dmSubjects.flatMap((s) => s.facts)
      expect(dmFacts.some((f) => f.shortId === 'm-2222da' && !f.crossGroup)).toBe(true)
      expect(dmFacts.some((f) => f.crossGroup && f.shortId?.startsWith('m-2222'))).toBe(true)

      // 3. 给甲群开启单群隔离锁 isolateGroupMemory -> 甲群事实立即停止外流至乙群；取消后锁住乙群同样禁止接收跨群印象
      await withCircle(database.db, personal.id, (tx) =>
        replaceClientGroupRules(tx, personal.id, botKey.client.id, [
          { groupSubjectId: gAId, personaId: null, isolateGroupMemory: true },
        ]),
      )
      const lockedSessionB = await resolveKeySession(deps, sharedPrincipal, groupBCtx)
      const lockedRecallB = await recallScopeForKey(deps, sharedPrincipal, lockedSessionB).recall(
        '咖啡拿铁',
        { limit: 10, minScore: 0.1 },
      )
      expect(lockedRecallB).toHaveLength(0)

      await withCircle(database.db, personal.id, (tx) =>
        replaceClientGroupRules(tx, personal.id, botKey.client.id, [
          { groupSubjectId: gBId, personaId: null, isolateGroupMemory: true },
        ]),
      )
      const destLockedSessionB = await resolveKeySession(deps, sharedPrincipal, groupBCtx)
      const destLockedRecallB = await recallScopeForKey(
        deps,
        sharedPrincipal,
        destLockedSessionB,
      ).recall('咖啡拿铁', { limit: 10, minScore: 0.1 })
      expect(destLockedRecallB).toHaveLength(0)
    })

    it('完成本人跨平台绑定（「这是我」）与私聊提权至 internal，且无缝轮换访问密钥与跨圈实时召回统计', async () => {
      const { account: alice, personal } = await seedAccount(database.db, 'alice')
      const sharedRes = await createSharedCircle(database.db, {
        name: '工作共享圈',
        defaultFacets: { realm: ['work'] },
        ownerAccountId: alice.id,
      })
      if (!sharedRes.ok) throw new Error('建共享圈失败')
      const sharedCircleId = sharedRes.value.id

      const deps = makeDeps(database.db)
      const personalSvc = await entryServiceForConsole(deps, personal.id, alice.id)
      const sharedSvc = await entryServiceForConsole(deps, sharedCircleId, alice.id)

      const publicEntry = await personalSvc.create({
        title: '公开开发清单',
        sensitivity: 'public',
        content: '团队统一使用 pnpm。',
      })
      const internalEntry = await personalSvc.create({
        title: '内部项目排期细节',
        sensitivity: 'internal',
        content: '内测分支下周一冻结接口。',
      })
      const privateEntry = await personalSvc.create({
        title: '本人私人银行卡备注',
        sensitivity: 'private',
        content: '个人私人账单备注。',
      })
      const awayPublicEntry = await sharedSvc.create({
        title: '共享客场 pnpm 部署说明',
        sensitivity: 'public',
        content: '共享客场 pnpm 部署入口统一切换至新网关，所有 pnpm 部署流程保持一致。',
        glossary: ['pnpm', '部署'],
      })

      const issued = await withCircle(database.db, personal.id, async (tx) => {
        const cRes = await createClient(tx, {
          circleId: personal.id,
          ownerAccountId: alice.id,
          slug: 'multi-bot',
          name: '跨端本人绑定机器人',
          runtimeFamily: 'astrbot',
        })
        if (!cRes.ok) throw new Error('建实例失败')
        await updateClient(tx, {
          circleId: personal.id,
          clientId: cRes.client.id,
          config: {
            personMemoryMode: 'strict',
            elevateOwnerDirect: 'internal',
            recordPrompt: true,
          },
        })
        // 先在库里登记已验证的 QQ 本人联系人与规则（供后续验证轮换继承与绑定合并）
        const [qqSub] = await tx
          .insert(subjects)
          .values({
            circleId: personal.id,
            kind: 'person',
            displayName: '主人QQ',
            accountId: alice.id,
          })
          .returning()
        const [grpSub] = await tx
          .insert(subjects)
          .values({ circleId: personal.id, kind: 'group', displayName: '工作群' })
          .returning()
        await tx.insert(subjectIdentities).values([
          {
            circleId: personal.id,
            subjectId: qqSub!.id,
            kind: 'person',
            platform: 'qq',
            externalId: 'qq-owner-1',
            displayName: '主人QQ',
          },
          {
            circleId: personal.id,
            subjectId: grpSub!.id,
            kind: 'group',
            platform: 'qq',
            externalId: 'qq-grp-1',
            displayName: '工作群',
          },
        ])
        await replaceClientGroupRules(tx, personal.id, cRes.client.id, [
          { groupSubjectId: grpSub!.id, personaId: null, isolateGroupMemory: true },
        ])
        const kRes = await issueClientKey(tx, {
          circleId: personal.id,
          clientId: cRes.client.id,
          accountId: alice.id,
          name: '旧密钥',
          linkedCircles: [{ circleId: sharedCircleId, mode: 'read' }],
          scopes: READ_WRITE_ALL,
        })
        if (!kRes.ok) throw new Error('签发密钥失败')
        return kRes
      })

      const oldPrincipal = (await principalForKeyId(database.db, issued.row.id))!
      const qqDmSession = await resolveKeySession(deps, oldPrincipal, {
        chatType: 'direct',
        platform: 'qq',
        sender: { id: 'qq-owner-1', name: '主人QQ' },
      })
      expect(qqDmSession.context.senderIsOwner).toBe(true)

      // 主人 QQ 发起跨平台绑定码 -> 无缝轮换密钥 -> 新 TG 账号用新密钥兑换并由本人 confirmBinding 审批合并
      const codeObj = await issueCode(
        database.db,
        deps.masterKey,
        oldPrincipal,
        qqDmSession,
        'qq',
        'qq-owner-1',
      )
      expect(codeObj).not.toBeNull()

      const rotated = await withCircle(database.db, personal.id, (tx) =>
        rotateClientKey(tx, {
          circleId: personal.id,
          clientId: issued.client.id,
          keyId: issued.row.id,
          accountId: alice.id,
          name: '轮换后新密钥',
        }),
      )
      if (!rotated.ok) throw new Error('密钥轮换失败')
      expect(await principalForKeyId(database.db, issued.row.id)).toBeNull()

      const newPrincipal = (await principalForKeyId(database.db, rotated.row.id))!
      expect(newPrincipal.circleGrants.some((g) => g.circleId === sharedCircleId && g.active)).toBe(
        true,
      )

      const tgDmContext = {
        chatType: 'direct' as const,
        platform: 'tg',
        sender: { id: 'tg-owner-99', name: '主人TG' },
      }
      const tgSessionBefore = await resolveKeySession(deps, newPrincipal, tgDmContext)
      expect(tgSessionBefore.context.senderIsOwner).toBe(false)

      const normalized = normalizeCode(codeObj!.code)!
      const preview = await redeemCode(
        database.db,
        deps.masterKey,
        newPrincipal,
        tgSessionBefore,
        normalized,
        { platform: 'tg', externalId: 'tg-owner-99', displayName: '主人TG' },
        false,
      )
      expect(preview).toMatchObject({ kind: 'preview', needsApproval: true })

      const pending = await redeemCode(
        database.db,
        deps.masterKey,
        newPrincipal,
        tgSessionBefore,
        normalized,
        { platform: 'tg', externalId: 'tg-owner-99', displayName: '主人TG' },
        true,
      )
      expect(pending.kind).toBe('pending')

      const pendingRow = await withCircle(database.db, personal.id, (tx) =>
        tx.select().from(subjectBindings).where(eq(subjectBindings.status, 'pending')).limit(1),
      )
      const confirmed = await confirmBinding(
        database.db,
        personal.id,
        pendingRow[0]!.id,
        alice.id,
        'owner',
      )
      expect(confirmed.ok).toBe(true)

      // 合并后 TG 私聊升级为本人私聊（可读 public + internal，仍硬拒 private；同人在群聊中仍封顶 public）
      const tgSessionAfter = await resolveKeySession(deps, newPrincipal, tgDmContext)
      expect(tgSessionAfter.context.senderIsOwner).toBe(true)
      const tgEntrySvc = entryServiceForKey(deps, newPrincipal, tgSessionAfter)
      expect((await tgEntrySvc.get({ id: internalEntry.shortId })).shortId).toBe(
        internalEntry.shortId,
      )
      await expect(tgEntrySvc.get({ id: privateEntry.shortId })).rejects.toSatisfy(
        (e) => e instanceof MemoryError && e.status === 404,
      )

      const ownerInGroupSession = await resolveKeySession(deps, newPrincipal, {
        chatType: 'group',
        platform: 'qq',
        group: { id: 'qq-grp-1', name: '工作群' },
        sender: { id: 'qq-owner-1', name: '主人QQ' },
      })
      const groupEntrySvc = entryServiceForKey(deps, newPrincipal, ownerInGroupSession)
      await expect(groupEntrySvc.get({ id: internalEntry.shortId })).rejects.toSatisfy(
        (e) => e instanceof MemoryError && e.status === 404,
      )
      expect((await groupEntrySvc.get({ id: publicEntry.shortId })).shortId).toBe(
        publicEntry.shortId,
      )

      // 用新密钥在本机无上下文下触发跨圈召回并沉淀统计：
      // 验证 recall_events / recall_event_hits 写入主场圈，且 entry_recall_stats 跨主场圈与关联客场圈实时同步累加
      const recallRes = await recallRequest(
        deps,
        newPrincipal,
        { query: 'pnpm 部署', limit: 10, crossCircle: true, includeSubjects: false },
        (s, o) => recallScopeForKey(deps, newPrincipal, s, o),
      )
      expect(recallRes.candidates.some((c) => c.shortId === publicEntry.shortId)).toBe(true)
      expect(recallRes.candidates.some((c) => c.shortId === awayPublicEntry.shortId)).toBe(true)

      await settleRecallEvents()

      await withCircle(database.db, personal.id, async (tx) => {
        const evRows = await tx.select().from(recallEvents)
        const hitRows = await tx.select().from(recallEventHits)
        const statRows = await tx.select().from(entryRecallStats)
        expect(evRows).toHaveLength(1)
        expect(hitRows.some((h) => h.targetCircleId === sharedCircleId)).toBe(true)
        expect(statRows.find((s) => s.entryId === publicEntry.id)?.count).toBe(1)
      })
      await withCircle(database.db, sharedCircleId, async (tx) => {
        const sharedStats = await tx.select().from(entryRecallStats)
        expect(sharedStats.find((s) => s.entryId === awayPublicEntry.id)?.count).toBe(1)
      })

      // 校验 recallDebug 在受限群聊上下文对 internal 词条给出 filtered 拒绝理由
      const memberCtx = (await consoleCircleFor(deps, alice.id, personal.id))!
      const debugInGroup = await recallDebug(
        deps,
        newPrincipal,
        memberCtx.access,
        { query: '内测分支冻结接口', crossCircle: true },
        {
          context: {
            chatType: 'group',
            platform: 'qq',
            group: { id: 'qq-grp-1', name: '工作群' },
            sender: { id: 'qq-owner-1', name: '主人QQ' },
          },
        },
      )
      expect(debugInGroup.filtered.some((f) => f.shortId === internalEntry.shortId)).toBe(true)
      void accessForKey
    })
  },
)
