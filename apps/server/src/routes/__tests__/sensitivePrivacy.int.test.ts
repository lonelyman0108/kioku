import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import {
  DEFAULT_CIRCLE_PRIVACY,
  InboxCounts,
  type CirclePrivacySettings,
  type ConsoleEntryView,
  type DreamSuggestionList,
  type EntryHistory,
  type EntryList,
  type EntryView,
  type ModelChainTestResult,
  type PrivacyBindingView,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { rotateMasterKey } from '../../crypto/rotation'
import { withCircle, type Database } from '../../db/client'
import {
  dreamSuggestions,
  entryCredentialRefs,
  entryEvents,
  entryRecallStats,
  settings,
} from '../../db/schema'
import type { Embedder } from '../../embedding/provider'
import { staticEmbedderSource } from '../../embedding/source'
import { embedEntries } from '../../embedding/worker'
import { dreamCircle } from '../../extraction/dream'
import { saveExtractionConfig } from '../../extraction/settings'
import { embedQuery } from '../../recall/recall'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import { fakeChatModel } from '../../testing/fakeChatModel'
import { bootstrap, jsonRequest, type Workspace } from '../../testing/fixtures'

describe.skipIf(!testDatabaseUrl)('敏感内容与隐私设置', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  const masterKey = randomBytes(32)

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })

  afterAll(async () => {
    if (!database) return
    await database.db.delete(settings).where(eq(settings.key, 'privacy_model'))
    await database.db.delete(settings).where(eq(settings.key, 'extraction'))
    await database.close()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    await database.db.delete(settings).where(eq(settings.key, 'privacy_model'))
    await database.db.delete(settings).where(eq(settings.key, 'extraction'))
    ws = await bootstrap(app)
  })

  const send = (method: string, path: string, body?: unknown, cookie = ws.cookie) =>
    app.request(
      `/v1${path}`,
      body === undefined
        ? { method, headers: { cookie, 'sec-fetch-site': 'same-origin' } }
        : jsonRequest(method, body, { cookie }),
    )

  const getEntry = async (id: string, circleId = ws.circleId) => {
    const res = await send('GET', `/circles/${circleId}/entries?id=${encodeURIComponent(id)}`)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as ConsoleEntryView
  }

  const createEntry = async (
    content: string,
    title = '联系方式',
    sensitivity?: 'public' | 'internal' | 'private' | 'secret',
    circleId = ws.circleId,
  ) => {
    const res = await send('POST', `/circles/${circleId}/entries`, {
      title,
      content,
      ...(sensitivity ? { sensitivity } : {}),
    })
    expect(res.status, await res.clone().text()).toBe(201)
    return (await res.json()) as ConsoleEntryView
  }

  it('个人圈私密 PII 保留原文且不进待处理，边界外 PII 支持迁入个人圈、提升防护与抹除敏感段', async () => {
    // 1. 已处于个人圈私密且受信任的 PII：保留 findings（供详情提示与出站脱敏），但不进待处理告警
    const alreadySafe = await createEntry(
      '本人备用号 13700009999',
      '备用联系',
      'private',
      ws.personalCircleId,
    )
    expect(alreadySafe.variants[0]!.sensitiveFindings?.map((f) => f.kind)).toContain('phone')
    expect(
      InboxCounts.parse(
        await (await send('GET', `/circles/${ws.personalCircleId}/inbox/counts`)).json(),
      ).plaintext,
    ).toBe(0)

    // 2. 位于共享圈（public）或个人圈非私密（internal）的 PII 进入待处理
    const shared = await createEntry(
      '备用手机 13812345678，邮箱 alice@corp-acme.com',
      '共享手机',
      'public',
      ws.circleId,
    )
    expect(shared.variants[0]!.sensitiveFindings?.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['phone', 'email']),
    )

    const personalInternal = await createEntry(
      '客服号码 13900001111',
      '客服号码',
      'internal',
      ws.personalCircleId,
    )

    const sharedCounts = InboxCounts.parse(
      await (await send('GET', `/circles/${ws.circleId}/inbox/counts`)).json(),
    )
    expect(sharedCounts.plaintext).toBe(1)

    const personalCounts = InboxCounts.parse(
      await (await send('GET', `/circles/${ws.personalCircleId}/inbox/counts`)).json(),
    )
    expect(personalCounts.plaintext).toBe(1)

    const listRes = await send(
      'GET',
      `/circles/${ws.personalCircleId}/entries/list?plaintext=true&sensitiveCategory=pii`,
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as EntryList
    expect(list.items.map((m) => m.id)).toContain(personalInternal.id)
    expect(list.items.map((m) => m.id)).not.toContain(alreadySafe.id)

    // 3. 迁入个人圈：迁到 personalCircle + private，完整保留原文，移除共享圈待处理红点
    const transferRes = await send('POST', `/circles/${ws.circleId}/entries/transfer`, {
      entryId: shared.id,
      toCircleId: ws.personalCircleId,
    })
    expect(transferRes.status, await transferRes.clone().text()).toBe(200)
    const movedSafe = (await transferRes.json()) as ConsoleEntryView
    expect(movedSafe.circleId).toBe(ws.personalCircleId)
    expect(movedSafe.shortId).toBe(shared.shortId)
    expect(movedSafe.sensitivity).toBe('private')
    expect(movedSafe.variants[0]!.content).toBe('备用手机 13812345678，邮箱 alice@corp-acme.com')

    // 共享圈上的 protect personal_private 明确拒绝
    const sharedProtectFail = await send('POST', `/circles/${ws.circleId}/entries/protect`, {
      entryId: (await createEntry('临时号码 13600001111', '临时', undefined, ws.circleId)).id,
      expectedVersion: 1,
      target: 'personal_private',
    })
    expect(sharedProtectFail.status).toBe(400)

    // 4a. 个人圈内部 -> personal_private：原地提升，记录 protect 事件并消除红点
    const protectPersonalRes = await send(
      'POST',
      `/circles/${ws.personalCircleId}/entries/protect`,
      {
        entryId: personalInternal.id,
        expectedVersion: personalInternal.version,
        target: 'personal_private',
      },
    )
    expect(protectPersonalRes.status, await protectPersonalRes.clone().text()).toBe(200)
    const protectedPersonal = (await protectPersonalRes.json()) as ConsoleEntryView
    expect(protectedPersonal.sensitivity).toBe('private')
    expect(protectedPersonal.variants[0]!.content).toBe('客服号码 13900001111')

    const protectHistory = (await (
      await send(
        'GET',
        `/circles/${ws.personalCircleId}/entries/history?id=${encodeURIComponent(personalInternal.id)}`,
      )
    ).json()) as EntryHistory
    expect(protectHistory.events.some((e) => e.type === 'protect')).toBe(true)

    expect(
      InboxCounts.parse(
        await (await send('GET', `/circles/${ws.personalCircleId}/inbox/counts`)).json(),
      ).plaintext,
    ).toBe(0)

    // 4b. 设为机密：原地密文保护、清除敏感标签
    const protectSecretRes = await send('POST', `/circles/${ws.personalCircleId}/entries/protect`, {
      entryId: protectedPersonal.id,
      expectedVersion: protectedPersonal.version,
      target: 'secret',
    })
    expect(protectSecretRes.status, await protectSecretRes.clone().text()).toBe(200)
    const sealed = (await protectSecretRes.json()) as ConsoleEntryView
    expect(sealed.sensitivity).toBe('secret')
    expect(sealed.contentHidden).toBe(true)

    // 4c. 机密词条禁止经 protect 降级为 personal_private，且 private -> secret 会清理 entry_credential_refs
    const downgradeViaProtect = await send(
      'POST',
      `/circles/${ws.personalCircleId}/entries/protect`,
      {
        entryId: sealed.id,
        expectedVersion: sealed.version,
        target: 'personal_private',
      },
    )
    expect(downgradeViaProtect.status).toBe(400)
    expect((await getEntry(sealed.id, ws.personalCircleId)).sensitivity).toBe('secret')

    const credCreateRes = await send('POST', `/circles/${ws.personalCircleId}/credentials`, {
      identifier: 'protect_test_key',
      name: '保护回归凭据',
      source: { kind: 'new', values: { password: 'secret-value-123' } },
    })
    expect(credCreateRes.status, await credCreateRes.clone().text()).toBe(201)
    const entryWithCred = await createEntry(
      '登录密码见 {{cred:protect_test_key#password}}',
      '凭据引用词条',
      'private',
      ws.personalCircleId,
    )
    const refsBefore = await withCircle(database.db, ws.personalCircleId, (tx) =>
      tx
        .select()
        .from(entryCredentialRefs)
        .where(eq(entryCredentialRefs.entryId, entryWithCred.id)),
    )
    expect(refsBefore).toHaveLength(1)
    const sealCredEntryRes = await send('POST', `/circles/${ws.personalCircleId}/entries/protect`, {
      entryId: entryWithCred.id,
      expectedVersion: entryWithCred.version,
      target: 'secret',
    })
    expect(sealCredEntryRes.status, await sealCredEntryRes.clone().text()).toBe(200)
    const refsAfter = await withCircle(database.db, ws.personalCircleId, (tx) =>
      tx
        .select()
        .from(entryCredentialRefs)
        .where(eq(entryCredentialRefs.entryId, entryWithCred.id)),
    )
    expect(refsAfter).toHaveLength(0)

    // 5. 误粘贴的冗余敏感文本支持 stars 与 tag 两种模式抹除敏感段
    const noiseA = await createEntry('误粘贴手机 13812345678', '噪音A')
    const noiseB = await createEntry('误粘贴手机 13900001111', '噪音B')

    const redactRes = await send('POST', `/circles/${ws.circleId}/entries/redact`, {
      entryId: noiseA.id,
      expectedVersion: noiseA.version,
      mode: 'stars',
    })
    expect(redactRes.status, await redactRes.clone().text()).toBe(200)
    const redacted = (await redactRes.json()) as ConsoleEntryView
    expect(redacted.variants[0]!.content).toBe('误粘贴手机 ***')
    expect(redacted.variants[0]!.sensitiveFindings ?? []).toEqual([])

    const tagRes = await send('POST', `/circles/${ws.circleId}/entries/redact`, {
      entryId: noiseB.id,
      expectedVersion: noiseB.version,
      mode: 'tag',
    })
    expect(tagRes.status, await tagRes.clone().text()).toBe(200)
    const tagged = (await tagRes.json()) as ConsoleEntryView
    expect(tagged.variants[0]!.content).toBe('误粘贴手机 [REDACTED:PHONE]')
    expect(tagged.variants[0]!.sensitiveFindings ?? []).toEqual([])

    const historyRes = await send(
      'GET',
      `/circles/${ws.circleId}/entries/history?id=${encodeURIComponent(noiseB.id)}`,
    )
    expect(historyRes.status).toBe(200)
    const history = (await historyRes.json()) as EntryHistory
    expect(history.events.some((e) => e.type === 'redact')).toBe(true)
  })

  it('记忆圈隐私设置支持可选个人信息开关、自定义规则、白名单与重扫存量词条', async () => {
    const ipEntry = await createEntry('出口节点公网地址 45.113.88.24', '出口节点')
    expect(ipEntry.variants[0]!.sensitiveFindings ?? []).toEqual([])

    const customEntry = await createEntry('内部编号 PROJ-SECRET-12345678', '内部编号')
    expect(customEntry.variants[0]!.sensitiveFindings ?? []).toEqual([])

    const getInitial = await send('GET', `/circles/${ws.circleId}/privacy`)
    expect(getInitial.status).toBe(200)
    expect((await getInitial.json()) as CirclePrivacySettings).toMatchObject({
      credentials: DEFAULT_CIRCLE_PRIVACY.credentials,
      pii: DEFAULT_CIRCLE_PRIVACY.pii,
    })

    // 开启 public_ip 并添加自定义规则
    const putRes = await send('PUT', `/circles/${ws.circleId}/privacy`, {
      piiKinds: { public_ip: true },
      customRules: [
        {
          kind: 'PROJ_TOKEN',
          prefix: 'PROJ-SECRET-',
        },
      ],
      allowlist: [],
    })
    expect(putRes.status, await putRes.clone().text()).toBe(200)

    // 显式触发重扫，存量两条词条应被标出
    const rescanRes = await send('POST', `/circles/${ws.circleId}/privacy/rescan`)
    expect(rescanRes.status).toBe(200)
    expect(await rescanRes.json()).toMatchObject({ queued: false })

    const ipAfter = await getEntry(ipEntry.id)
    expect(ipAfter.variants[0]!.sensitiveFindings?.map((f) => f.kind)).toContain('public_ip')

    const customAfter = await getEntry(customEntry.id)
    expect(
      customAfter.variants[0]!.sensitiveFindings?.some(
        (f) => f.category === 'credential' && f.label === 'PROJ_TOKEN',
      ),
    ).toBe(true)

    // 加入白名单并重扫，应该清除命中的标记
    await send('PUT', `/circles/${ws.circleId}/privacy`, {
      allowlist: ['45.113.88.24', 'PROJ-SECRET-12345678'],
    })
    await send('POST', `/circles/${ws.circleId}/privacy/rescan`)

    const clearedIp = await getEntry(ipEntry.id)
    expect(clearedIp.variants[0]!.sensitiveFindings ?? []).toEqual([])

    const clearedCustom = await getEntry(customEntry.id)
    expect(clearedCustom.variants[0]!.sensitiveFindings ?? []).toEqual([])
  })

  it('实例隐私识别模型可配置、测试、参入记忆圈检测，并在主密钥轮换时重包密钥', async () => {
    const server = createServer((req, res) => {
      if (req.url?.endsWith('/detect') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            results: [
              [
                {
                  label: 'PERSON',
                  start: 3,
                  end: 5,
                  score: 0.92,
                },
              ],
            ],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    const baseUrl = `http://127.0.0.1:${addr.port}/detect`

    try {
      const saveRes = await send('PUT', '/settings/models/bindings/privacy', {
        mode: 'http',
        baseUrl,
        apiKey: 'ner-secret-key',
        minScore: 0.7,
      })
      expect(saveRes.status, await saveRes.clone().text()).toBe(200)
      const view = (await saveRes.json()) as PrivacyBindingView
      expect(view).toMatchObject({ mode: 'http', baseUrl, hasApiKey: true, minScore: 0.7 })

      // 更换服务主机而不重填或清除 API Key 时应拒绝保存
      const crossHostRes = await send('PUT', '/settings/models/bindings/privacy', {
        mode: 'http',
        baseUrl: 'https://other.example.com/detect',
        minScore: 0.7,
      })
      expect(crossHostRes.status).toBe(400)

      const testRes = await send('POST', '/settings/models/bindings/privacy/test', {})
      expect(testRes.status, await testRes.clone().text()).toBe(200)
      const testBody = (await testRes.json()) as ModelChainTestResult
      expect(testBody.ok).toBe(true)
      expect(testBody.results[0]?.findings).toBe(1)

      // 记忆圈开启 usePrivacyModel 后写入词条会调用模型并记录命中的 PII
      await send('PUT', `/circles/${ws.circleId}/privacy`, { usePrivacyModel: true })
      const mem = await createEntry('联系人张三在值班中', '值班表')
      expect(
        mem.variants[0]!.sensitiveFindings?.some(
          (f) => f.category === 'pii' && f.kind === 'person',
        ),
      ).toBe(true)

      // 轮换主密钥后再测试一次，确保密文已用新密钥重包且仍可正常解开使用
      const nextKey = randomBytes(32)
      const rotated = await rotateMasterKey(database.db, {
        current: nextKey,
        previous: masterKey,
      })
      expect(rotated.rewrapped).toBeGreaterThanOrEqual(1)

      const appNext = createApp({
        db: database.db,
        cookieSecure: false,
        masterKey: nextKey,
        embedder: staticEmbedderSource(null),
        jobs: null,
      })
      const retestRes = await appNext.request('/v1/settings/models/bindings/privacy/test', {
        method: 'POST',
        headers: {
          cookie: ws.cookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({}),
      })
      expect(retestRes.status).toBe(200)
      expect(((await retestRes.json()) as ModelChainTestResult).ok).toBe(true)

      const offRes = await appNext.request('/v1/settings/models/bindings/privacy', {
        method: 'PUT',
        headers: {
          cookie: ws.cookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({ mode: 'off' }),
      })
      expect(offRes.status).toBe(200)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('整理可以生成高召回记忆的提升优先级建议并应用到词条上', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
    const created = await send('POST', `/circles/${ws.circleId}/entries`, {
      title: '发布前检查清单',
      content: '发布前必须跑完数据库迁移与冒烟检查',
      priority: 2,
    })
    expect(created.status).toBe(201)
    const mem = (await created.json()) as EntryView

    // 写入累计 4 次召回统计
    await withCircle(database.db, ws.circleId, (tx) =>
      tx.insert(entryRecallStats).values({
        entryId: mem.id,
        circleId: ws.circleId,
        count: 4,
        lastRecalledAt: new Date(),
      }),
    )

    const { model, calls } = fakeChatModel(async () =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'promote',
            entries: ['M1'],
            targetPriority: 1,
            reason: '近阶段被频繁召回 4 次，提升为重要有助于稳定注入',
          },
        ],
      }),
    )

    const outcome = await dreamCircle(database.db, masterKey, {
      circleId: ws.circleId,
      runId: randomUUID(),
      trigger: 'manual',
      modelFor: () => model,
    })
    expect(outcome.outcome).toBe('done')
    expect(calls[0]![1]!.content).toContain('"recallCount":4')

    const listRes = await send('GET', `/circles/${ws.circleId}/dream/suggestions`)
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as DreamSuggestionList
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ kind: 'promote', targetPriority: 1 })

    const applyRes = await send(
      'POST',
      `/circles/${ws.circleId}/dream/suggestions/${list.items[0]!.id}/apply`,
      {},
    )
    expect(applyRes.status, await applyRes.clone().text()).toBe(200)

    const after = await getEntry(mem.id)
    expect(after.priority).toBe(1)

    const [row] = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(dreamSuggestions).where(eq(dreamSuggestions.id, list.items[0]!.id)),
    )
    expect(row?.status).toBe('applied')

    const events = await withCircle(database.db, ws.circleId, (tx) =>
      tx.select().from(entryEvents).where(eq(entryEvents.entryId, mem.id)),
    )
    expect(events.some((e) => e.eventType === 'update')).toBe(true)
  })

  it('向外部嵌入、查询嵌入与整理模型外发前自动脱敏，且本地原文与拒收含脱敏标记的新建议均不受影响', async () => {
    const rawPhone = '13812345678'
    const rawEmail = 'bob@corp-acme.com'
    const mem = await createEntry(
      `本人联系电话 ${rawPhone}，账单邮箱 ${rawEmail}`,
      '个人联系方式',
      'private',
      ws.personalCircleId,
    )

    // 1. 嵌入写入前先脱敏，本地数据库仍保留完整原文
    const embeddedTexts: string[] = []
    const capturingEmbedder: Embedder = {
      model: 'capturing-embedder',
      async embed(texts) {
        embeddedTexts.push(...texts)
        return texts.map(() => Array.from({ length: 1024 }, () => 0.01))
      },
    }
    expect(await embedEntries(database.db, capturingEmbedder, ws.personalCircleId, [mem.id])).toBe(
      1,
    )
    expect(embeddedTexts).toHaveLength(1)
    expect(embeddedTexts[0]).toContain('[REDACTED:PHONE]')
    expect(embeddedTexts[0]).toContain('[REDACTED:EMAIL]')
    expect(embeddedTexts[0]).not.toContain(rawPhone)
    expect(embeddedTexts[0]).not.toContain(rawEmail)

    const storedAfterEmbed = await getEntry(mem.id, ws.personalCircleId)
    expect(storedAfterEmbed.variants[0]!.content).toContain(rawPhone)
    expect(storedAfterEmbed.variants[0]!.content).toContain(rawEmail)

    // 2. 语义查询嵌入前先脱敏
    await embedQuery(capturingEmbedder, `查询手机号 ${rawPhone}`)
    expect(embeddedTexts[1]).toBe('查询手机号 [REDACTED:PHONE]')

    // 3. 整理模型入参前先脱敏，同时拒绝模型回吐带 [REDACTED:...] 的合并建议覆盖原文
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
    await createEntry(`日常办公联系方式 ${rawPhone}`, '办公联系一', undefined, ws.circleId)
    await createEntry(`备用联系方式 ${rawEmail}`, '办公联系二', undefined, ws.circleId)

    const { model, calls } = fakeChatModel(async () =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'merge',
            entries: ['M1', 'M2'],
            keep: 'M1',
            content: '办公电话 [REDACTED:PHONE]，邮箱 [REDACTED:EMAIL]',
            reason: '两条联系信息可以合并',
          },
        ],
      }),
    )

    const outcome = await dreamCircle(database.db, masterKey, {
      circleId: ws.circleId,
      runId: randomUUID(),
      trigger: 'manual',
      modelFor: () => model,
    })
    expect(outcome.outcome).toBe('done')

    const promptSent = calls.map((msgs) => msgs.map((m) => m.content).join('\n')).join('\n')
    expect(promptSent).toContain('[REDACTED:PHONE]')
    expect(promptSent).toContain('[REDACTED:EMAIL]')
    expect(promptSent).not.toContain(rawPhone)
    expect(promptSent).not.toContain(rawEmail)

    const suggestions = (await (
      await send('GET', `/circles/${ws.circleId}/dream/suggestions`)
    ).json()) as DreamSuggestionList
    expect(suggestions.items).toEqual([])
  })
})
