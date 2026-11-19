import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPersonalCircle } from '../../access/circles'
import { createClient, updateClient } from '../../access/clients'
import { issueClientKey } from '../../access/issue'
import { principalForKeyId } from '../../auth/middleware'
import { withCircle, type Database, type Db } from '../../db/client'
import {
  EMBEDDING_DIMENSIONS,
  accounts,
  conversations,
  conversationTurns,
  entries,
  entryEmbeddings,
  entryVariants,
  extractionRuns,
  settings,
} from '../../db/schema'
import type { Embedder } from '../../embedding/provider'
import { staticEmbedderSource } from '../../embedding/source'
import { embedEntries } from '../../embedding/worker'
import type { Deps } from '../../http/env'
import { lifecycleEvent } from '../../lifecycle/handlers'
import { recallScopeForKey } from '../../memory/context'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { saveExtractionBudget } from '../budget'
import { bufferTurn, noContextScope, parseNoContextScope } from '../buffer'
import { extractBatch } from '../extract'
import type { ChatMessage, ChatModel } from '../provider'
import { saveExtractionConfig } from '../settings'

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

function makeDeps(db: Db): Deps {
  return {
    db,
    cookieSecure: false,
    masterKey: Buffer.alloc(32, 9),
    embedder: staticEmbedderSource(null),
    jobs: null,
  }
}

function mockEmbedder(model: string): Embedder {
  return {
    model,
    async embed(texts) {
      return texts.map((t) => {
        const digest = createHash('sha256').update(t).digest()
        const vec = Array.from(
          { length: EMBEDDING_DIMENSIONS },
          (_, i) => (digest[i % digest.length]! - 128) / 128,
        )
        const norm = Math.hypot(...vec) || 1
        return vec.map((v) => v / norm)
      })
    },
  }
}

describe.skipIf(!testDatabaseUrl)('细粒度对话抽取、无上下文缓冲与跨群作用域隔离', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings)
  })

  afterAll(async () => {
    await database.close()
  })

  it('支持带冒号的无上下文作用域编码、按 device×project 分会话以及私有会话摘要抽取', async () => {
    const encoded = noContextScope('acc:1', 'mac:work:laptop', 'org:repo:api')
    expect(parseNoContextScope(encoded)).toEqual({
      ownerAccountId: 'acc:1',
      deviceKey: 'mac:work:laptop',
      projectSlug: 'org:repo:api',
    })
    expect(parseNoContextScope('group:123')).toBeNull()
    expect(parseNoContextScope('["bad","1","2","3"]')).toBeNull()

    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    await saveExtractionConfig(database.db, Buffer.alloc(32, 9), {
      baseUrl: 'https://example.com/v1',
      model: 'extract-test',
      apiKey: 'sk-test-1234',
    })

    const issued = await withCircle(database.db, personal.id, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: personal.id,
        ownerAccountId: alice.id,
        slug: 'claudecode-mac',
        name: 'Claude Code',
        runtimeFamily: 'claudecode',
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      const kRes = await issueClientKey(tx, {
        circleId: personal.id,
        clientId: cRes.client.id,
        accountId: alice.id,
        name: '本机密钥',
        contextFacets: { env: ['mac'] },
        scopes: {
          readKinds: ['entry', 'fact', 'episode'],
          writeKinds: ['entry', 'fact', 'episode'],
          maxSensitivity: 'private',
          credentials: 'none',
          allowedRealms: null,
          admin: false,
        },
      })
      if (!kRes.ok) throw new Error('签发密钥失败')
      return kRes
    })

    const deps = makeDeps(database.db)
    const principal = (await principalForKeyId(database.db, issued.row.id))!
    const scopeFor = (
      session: Parameters<typeof recallScopeForKey>[2],
      opts?: Parameters<typeof recallScopeForKey>[3],
    ) => recallScopeForKey(deps, principal, session, opts)

    await lifecycleEvent(
      deps,
      principal,
      {
        event: 'turn.end',
        sessionId: 'sess-alpha',
        deviceKey: 'mac:a',
        project: { repoName: 'repo:one' },
        user: '今天先把切面词表测试补完。',
        reply: '好的，先检查蕴含展开逻辑。',
      },
      scopeFor,
    )
    await lifecycleEvent(
      deps,
      principal,
      {
        event: 'turn.end',
        sessionId: 'sess-beta',
        deviceKey: 'mac:b',
        project: { repoName: 'repo:one' },
        user: '切换另一台设备继续跑测试。',
        reply: '明白。',
      },
      scopeFor,
    )

    const seenPrompts: ChatMessage[][] = []
    const model: ChatModel = {
      model: 'mock-gpt',
      async complete(messages) {
        seenPrompts.push(messages)
        return {
          model: 'mock-gpt',
          content: JSON.stringify({
            facts: [
              {
                subject: 'M1',
                op: 'add',
                content: '应当被忽略的事实',
                quote: '今天先把切面词表测试补完',
              },
            ],
            summary: '决定先补齐切面词表测试。',
          }),
          usage: { promptTokens: 20, completionTokens: 12 },
        }
      },
    }

    const scopeA = noContextScope(alice.id, 'mac:a', 'repo-one')
    const scopeB = noContextScope(alice.id, 'mac:b', 'repo-one')
    await extractBatch(database.db, deps.masterKey, model, {
      circleId: personal.id,
      clientId: issued.client.id,
      scope: scopeA,
    })
    await extractBatch(database.db, deps.masterKey, model, {
      circleId: personal.id,
      clientId: issued.client.id,
      scope: scopeB,
    })

    expect(seenPrompts).toHaveLength(2)
    await withCircle(database.db, personal.id, async (tx) => {
      const convRows = await tx.select().from(conversations)
      expect(convRows.filter((c) => c.kind === 'none')).toHaveLength(2)
      expect(convRows.map((c) => c.deviceKey).sort()).toEqual(['mac:a', 'mac:b'])

      const turnLeft = await tx.select().from(conversationTurns)
      expect(turnLeft).toHaveLength(0)

      const entryRows = await tx.select().from(entries)
      expect(entryRows.every((e) => e.kind === 'episode')).toBe(true)
      expect(entryRows).toHaveLength(2)
      for (const ep of entryRows) {
        expect(ep.sensitivity).toBe('private')
        expect(ep.provenance).toBe('agent')
        expect(ep.ownerAccountId).toBe(alice.id)
        expect(ep.subjectId).toBeNull()
        expect(ep.subjectKind).toBeNull()
        expect(ep.clientId).toBe(issued.client.id)
        expect(ep.conversationId).toBeTruthy()
      }

      const variantRows = await tx.select().from(entryVariants)
      expect(variantRows).toHaveLength(2)
      expect(variantRows.every((v) => v.whenSignature === '{}')).toBe(true)

      const runRows = await tx.select().from(extractionRuns)
      expect(runRows.every((r) => r.summarized && !r.summaryOnly)).toBe(true)
    })
  })

  it('完成群聊个人与群事实抽取、原话与敏感校验、replaces 取代、每日限额及月度预算降级', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    await saveExtractionConfig(database.db, Buffer.alloc(32, 9), {
      baseUrl: 'https://example.com/v1',
      model: 'extract-test',
      apiKey: 'sk-test-1234',
    })

    const issued = await withCircle(database.db, personal.id, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: personal.id,
        ownerAccountId: alice.id,
        slug: 'qq-bot',
        name: 'QQ 助手',
        runtimeFamily: 'astrbot',
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      const kRes = await issueClientKey(tx, {
        circleId: personal.id,
        clientId: cRes.client.id,
        accountId: alice.id,
        name: '群聊密钥',
        contextFacets: { env: ['qq-bot'], realm: ['social'] },
        scopes: {
          readKinds: ['entry', 'fact', 'episode'],
          writeKinds: ['entry', 'fact', 'episode'],
          maxSensitivity: 'private',
          credentials: 'none',
          allowedRealms: null,
          admin: false,
        },
      })
      if (!kRes.ok) throw new Error('签发密钥失败')
      return kRes
    })

    const deps = makeDeps(database.db)
    const principal = (await principalForKeyId(database.db, issued.row.id))!
    const scopeFor = (
      session: Parameters<typeof recallScopeForKey>[2],
      opts?: Parameters<typeof recallScopeForKey>[3],
    ) => recallScopeForKey(deps, principal, session, opts)

    const groupContext = {
      chatType: 'group' as const,
      platform: 'qq',
      group: { id: 'group-alpha', name: '技术交流群' },
      sender: { id: 'user-zhangsan', name: '张三' },
    }

    await lifecycleEvent(
      deps,
      principal,
      {
        event: 'turn.end',
        sessionId: 'grp-turn-1',
        context: groupContext,
        user: '我最近固定用 TypeScript 写后端，周三晚上大家一起开同步会，顺便别记我手机号 13900139000。',
        reply: '机器人说：好的，我还擅长做烤鱼。',
      },
      scopeFor,
    )

    const queuedTurns = await withCircle(database.db, personal.id, (tx) =>
      tx.select().from(conversationTurns),
    )
    expect(queuedTurns).toHaveLength(1)
    const groupScope = queuedTurns[0]!.scope
    expect(groupScope.startsWith('group:')).toBe(true)

    const createdIds: string[] = []
    const batchOneModel: ChatModel = {
      model: 'mock-gpt',
      async complete() {
        return {
          model: 'mock-gpt',
          content: JSON.stringify({
            facts: [
              // 合法个人事实
              {
                subject: 'M1',
                op: 'add',
                content: '主要使用 TypeScript 开发后端',
                quote: '固定用 TypeScript 写后端',
              },
              // 合法群事实
              {
                subject: 'G',
                op: 'add',
                content: '每周三晚上举行同步会',
                quote: '周三晚上大家一起开同步会',
              },
              // 幻觉 / 错抄机器人回复（应丢弃）
              { subject: 'M1', op: 'add', content: '擅长做烤鱼', quote: '我还擅长做烤鱼' },
              // 含脱敏标记或敏感信息或凭据占位符（均应丢弃）
              {
                subject: 'M1',
                op: 'add',
                content: '脱敏占位 [REDACTED:PHONE]',
                quote: '周三晚上大家一起开同步会',
              },
              { subject: 'M1', op: 'add', content: '电话 13900139000', quote: '别记我手机号' },
              {
                subject: 'M1',
                op: 'add',
                content: '密码 {{cred:github}}',
                quote: '固定用 TypeScript 写后端',
              },
            ],
            summary: '群友约定周三晚上同步，期间提到 13900139000。',
          }),
          usage: { promptTokens: 40, completionTokens: 20 },
        }
      },
    }

    await extractBatch(
      database.db,
      deps.masterKey,
      batchOneModel,
      { circleId: personal.id, clientId: issued.client.id, scope: groupScope },
      (_circleId, entryId) => createdIds.push(entryId),
    )

    expect(createdIds).toHaveLength(2)
    await embedEntries(database.db, mockEmbedder('test-vec'), personal.id, createdIds)

    let personFactId = ''
    await withCircle(database.db, personal.id, async (tx) => {
      const rows = await tx.select().from(entries)
      const pFact = rows.find((r) => r.kind === 'fact' && r.subjectKind === 'person')!
      const gFact = rows.find((r) => r.kind === 'fact' && r.subjectKind === 'group')!
      const ep = rows.find((r) => r.kind === 'episode')!

      expect(pFact).toBeDefined()
      expect(gFact).toBeDefined()
      expect(ep).toBeDefined()
      personFactId = pFact.id

      expect(pFact.shortId).toMatch(/^m-[2-9a-hjkmnp-tv-z]{6}$/)
      expect(pFact.provenance).toBe('untrusted')
      expect(pFact.originScope).toBe(groupScope)
      expect(pFact.clientId).toBe(issued.client.id)
      expect(pFact.realms).toEqual(['social'])
      expect(gFact.provenance).toBe('untrusted')
      expect(gFact.originScope).toBe(groupScope)
      expect(ep.provenance).toBe('untrusted')
      expect(ep.subjectId).toBeNull()

      const variants = await tx.select().from(entryVariants)
      const pv = variants.find((v) => v.entryId === pFact.id)!
      const ev = variants.find((v) => v.entryId === ep.id)!
      expect(pv.when).toEqual({ env: ['qq-bot'], realm: ['social'] })
      expect(ev.when).toEqual({})
      expect(ev.content).not.toContain('13900139000')
      expect(ev.content).toContain('***')

      const embBefore = await tx
        .select()
        .from(entryEmbeddings)
        .where(eq(entryEmbeddings.entryId, personFactId))
      expect(embBefore).toHaveLength(1)

      const runs = await tx.select().from(extractionRuns)
      expect(runs[0]!.added).toBe(2)
      expect(runs[0]!.dropped).toBe(4)
      expect(runs[0]!.summarized).toBe(true)
    })

    // 第二批：测试 replaces 取代旧事实并清除旧向量 + 每日写入上限（dailyWritesPerSubject = 2 -> 已写入 1，本批最多再写 1 条，第 2 条计入 limited）
    await saveExtractionBudget(database.db, personal.id, {
      monthlyTokens: 1000,
      dailyWritesPerSubject: 2,
    })
    await lifecycleEvent(
      deps,
      principal,
      {
        event: 'turn.end',
        sessionId: 'grp-turn-2',
        context: groupContext,
        user: '我现在改用 Go 写后端了，平时也爱喝拿铁和乌龙茶。',
        reply: '了解了。',
      },
      scopeFor,
    )

    const batchTwoModel: ChatModel = {
      model: 'mock-gpt',
      async complete() {
        return {
          model: 'mock-gpt',
          content: JSON.stringify({
            facts: [
              {
                subject: 'M1',
                op: 'update',
                replaces: 'F1',
                content: '已改用 Go 开发后端',
                quote: '现在改用 Go 写后端了',
              },
              {
                subject: 'M1',
                op: 'add',
                content: '平时喜欢喝拿铁',
                quote: '平时也爱喝拿铁',
              },
            ],
            summary: '',
          }),
          usage: { promptTokens: 1200, completionTokens: 20 },
        }
      },
    }

    await extractBatch(database.db, deps.masterKey, batchTwoModel, {
      circleId: personal.id,
      clientId: issued.client.id,
      scope: groupScope,
    })

    await withCircle(database.db, personal.id, async (tx) => {
      const oldFact = (await tx.select().from(entries).where(eq(entries.id, personFactId)))[0]!
      expect(oldFact.validTo).not.toBeNull()

      const oldEmb = await tx
        .select()
        .from(entryEmbeddings)
        .where(eq(entryEmbeddings.entryId, personFactId))
      expect(oldEmb).toHaveLength(0)

      const runs = await tx.select().from(extractionRuns)
      expect(runs).toHaveLength(2)
      const secondRun = runs[1]!
      expect(secondRun.updated).toBe(1)
      expect(secondRun.limited).toBe(1)
    })

    // 第三批：本月累计 token 已超 1000，降级为 summaryOnly，仅走摘要消息、不传已有事实也不写入 fact
    await lifecycleEvent(
      deps,
      principal,
      {
        event: 'turn.end',
        sessionId: 'grp-turn-3',
        context: groupContext,
        user: '下周开始准备压测脚本。',
        reply: '好的。',
      },
      scopeFor,
    )

    let thirdPromptText = ''
    const batchThreeModel: ChatModel = {
      model: 'mock-gpt',
      async complete(messages) {
        thirdPromptText = messages.map((m) => m.content).join('\n')
        return {
          model: 'mock-gpt',
          content: JSON.stringify({
            facts: [{ subject: 'M1', op: 'add', content: '在写压测脚本', quote: '准备压测脚本' }],
            summary: '决定下周开始写压测脚本。',
          }),
          usage: { promptTokens: 10, completionTokens: 10 },
        }
      },
    }

    await extractBatch(database.db, deps.masterKey, batchThreeModel, {
      circleId: personal.id,
      clientId: issued.client.id,
      scope: groupScope,
    })

    expect(thirdPromptText).not.toContain('已改用 Go 开发后端')
    await withCircle(database.db, personal.id, async (tx) => {
      const runs = await tx.select().from(extractionRuns)
      expect(runs).toHaveLength(3)
      const thirdRun = runs[2]!
      expect(thirdRun.summaryOnly).toBe(true)
      expect(thirdRun.added).toBe(0)
      expect(thirdRun.summarized).toBe(true)
    })
  })

  it('即使开启 persona_shared 模式，抽取时仍严格按本 origin_scope 隔离且禁止跨群 replaces', async () => {
    const { account: alice, personal } = await seedAccount(database.db, 'alice')
    await saveExtractionConfig(database.db, Buffer.alloc(32, 9), {
      baseUrl: 'https://example.com/v1',
      model: 'extract-test',
      apiKey: 'sk-test-1234',
    })

    const issued = await withCircle(database.db, personal.id, async (tx) => {
      const cRes = await createClient(tx, {
        circleId: personal.id,
        ownerAccountId: alice.id,
        slug: 'shared-bot',
        name: '拟人跨群机器人',
        runtimeFamily: 'astrbot',
      })
      if (!cRes.ok) throw new Error('建接入实例失败')
      await updateClient(tx, {
        circleId: personal.id,
        clientId: cRes.client.id,
        config: { personMemoryMode: 'persona_shared', recordPrompt: false },
      })
      const kRes = await issueClientKey(tx, {
        circleId: personal.id,
        clientId: cRes.client.id,
        accountId: alice.id,
        name: '拟人密钥',
        scopes: {
          readKinds: ['entry', 'fact', 'episode'],
          writeKinds: ['entry', 'fact', 'episode'],
          maxSensitivity: 'private',
          credentials: 'none',
          allowedRealms: null,
          admin: false,
        },
      })
      if (!kRes.ok) throw new Error('签发密钥失败')
      return kRes
    })

    const deps = makeDeps(database.db)
    const principal = (await principalForKeyId(database.db, issued.row.id))!

    // 群甲：写入群友张三的一条事实
    const groupAContext = {
      chatType: 'group' as const,
      platform: 'qq',
      group: { id: 'g-alpha', name: '甲群' },
      sender: { id: 'u-shared-person', name: '张三' },
    }
    const sessionA = await (
      await import('../../access/session')
    ).resolveKeySession(deps, principal, groupAContext)
    await bufferTurn(deps, principal, sessionA, {
      event: 'turn.end',
      sessionId: 'sess-a',
      context: groupAContext,
      user: '我在甲群正在学 Rust 并发模型。',
      reply: '真棒。',
    })

    const scopeA = `group:${sessionA.context.groupSubjectId}`
    await extractBatch(
      database.db,
      deps.masterKey,
      {
        model: 'mock-gpt',
        async complete() {
          return {
            model: 'mock-gpt',
            content: JSON.stringify({
              facts: [
                {
                  subject: 'M1',
                  op: 'add',
                  content: '在学 Rust 并发模型',
                  quote: '正在学 Rust 并发模型',
                },
              ],
              summary: '',
            }),
            usage: { promptTokens: 10, completionTokens: 10 },
          }
        },
      },
      { circleId: personal.id, clientId: issued.client.id, scope: scopeA },
    )

    // 群乙：同一群友张三发言，抽取提示词中绝不能包含群甲事实，且伪造 replaces='F1' 不能取代群甲事实
    const groupBContext = {
      chatType: 'group' as const,
      platform: 'qq',
      group: { id: 'g-beta', name: '乙群' },
      sender: { id: 'u-shared-person', name: '张三' },
    }
    const sessionB = await (
      await import('../../access/session')
    ).resolveKeySession(deps, principal, groupBContext)
    await bufferTurn(deps, principal, sessionB, {
      event: 'turn.end',
      sessionId: 'sess-b',
      context: groupBContext,
      user: '我在乙群主要写前端 Vue 组件。',
      reply: '好的。',
    })

    const scopeB = `group:${sessionB.context.groupSubjectId}`
    let groupBPrompt = ''
    await extractBatch(
      database.db,
      deps.masterKey,
      {
        model: 'mock-gpt',
        async complete(messages) {
          groupBPrompt = messages.map((m) => m.content).join('\n')
          return {
            model: 'mock-gpt',
            content: JSON.stringify({
              facts: [
                {
                  subject: 'M1',
                  op: 'update',
                  replaces: 'F1',
                  content: '主要写前端 Vue 组件',
                  quote: '主要写前端 Vue 组件',
                },
              ],
              summary: '',
            }),
            usage: { promptTokens: 10, completionTokens: 10 },
          }
        },
      },
      { circleId: personal.id, clientId: issued.client.id, scope: scopeB },
    )

    expect(groupBPrompt).not.toContain('Rust')
    await withCircle(database.db, personal.id, async (tx) => {
      const factRows = (await tx.select().from(entries)).filter((e) => e.kind === 'fact')
      expect(factRows).toHaveLength(2)
      const alphaFact = factRows.find((f) => f.originScope === scopeA)!
      expect(alphaFact.validTo).toBeNull()
      expect(alphaFact.deletedAt).toBeNull()
    })
  })
})
