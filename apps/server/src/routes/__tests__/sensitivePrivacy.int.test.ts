import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

import {
  DEFAULT_SPACE_PRIVACY,
  InboxCounts,
  type ConsoleMemoryView,
  type DreamSuggestionList,
  type MemoryHistory,
  type MemoryList,
  type MemoryView,
  type PrivacyModelSettingsView,
  type PrivacyModelTestResult,
  type SpacePrivacySettings,
} from '@kioku/contracts'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import { rotateMasterKey } from '../../crypto/rotation'
import { withSpace, type Database } from '../../db/client'
import { dreamSuggestions, memoryEvents, memoryRecallStats, settings } from '../../db/schema'
import { staticEmbedderSource } from '../../embedding/source'
import { dreamSpace } from '../../extraction/dream'
import { saveExtractionConfig } from '../../extraction/settings'
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

  const getMemory = async (uri: string) => {
    const res = await send('GET', `/spaces/${ws.spaceId}/memories?uri=${encodeURIComponent(uri)}`)
    expect(res.status, await res.clone().text()).toBe(200)
    return (await res.json()) as ConsoleMemoryView
  }

  const createMemory = async (content: string, uri = 'user://contact') => {
    const res = await send('POST', `/spaces/${ws.spaceId}/memories`, {
      uri,
      title: '联系方式',
      content,
    })
    expect(res.status, await res.clone().text()).toBe(201)
    return (await res.json()) as ConsoleMemoryView
  }

  it('只含个人信息不拦截写入，进入待处理并支持两种模式一键打码', async () => {
    const first = await createMemory(
      '备用手机 13812345678，邮箱 alice@corp-acme.com',
      'user://phone-1',
    )
    expect(first.sensitiveFindings?.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['phone', 'email']),
    )

    const second = await createMemory('客服号码 13900001111', 'user://phone-2')

    const countsRes = await send('GET', `/spaces/${ws.spaceId}/inbox/counts`)
    expect(countsRes.status).toBe(200)
    expect(InboxCounts.parse(await countsRes.json()).plaintext).toBe(2)

    const listRes = await send(
      'GET',
      `/spaces/${ws.spaceId}/memories/list?plaintext=true&sensitiveCategory=pii`,
    )
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as MemoryList
    expect(list.items.map((m) => m.id)).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(list.items.every((m) => m.sensitivePii && !m.sensitiveCredential)).toBe(true)

    // 默认打码模式（***）
    const redactRes = await send('POST', `/spaces/${ws.spaceId}/memories/redact`, {
      memoryId: first.id,
      expectedVersion: first.version,
      mode: 'stars',
    })
    expect(redactRes.status, await redactRes.clone().text()).toBe(200)
    const redacted = (await redactRes.json()) as ConsoleMemoryView
    expect(redacted.content).not.toContain('13812345678')
    expect(redacted.content).not.toContain('alice@corp-acme.com')
    expect(redacted.content).toContain('***')
    expect(redacted.sensitiveFindings).toEqual([])

    // 类别标签打码模式（[REDACTED:PHONE]）
    const tagRes = await send('POST', `/spaces/${ws.spaceId}/memories/redact`, {
      memoryId: second.id,
      expectedVersion: second.version,
      mode: 'tag',
    })
    expect(tagRes.status, await tagRes.clone().text()).toBe(200)
    const tagged = (await tagRes.json()) as ConsoleMemoryView
    expect(tagged.content).toBe('客服号码 [REDACTED:PHONE]')
    expect(tagged.sensitiveFindings).toEqual([])

    // 打码后不再出现在待处理列表
    const afterCounts = InboxCounts.parse(
      await (await send('GET', `/spaces/${ws.spaceId}/inbox/counts`)).json(),
    )
    expect(afterCounts.plaintext).toBe(0)

    const historyRes = await send(
      'GET',
      `/spaces/${ws.spaceId}/memories/history?id=${encodeURIComponent(second.id)}`,
    )
    expect(historyRes.status).toBe(200)
    const history = (await historyRes.json()) as MemoryHistory
    expect(history.events.some((e) => e.type === 'redact')).toBe(true)
  })

  it('空间隐私设置支持可选个人信息开关、自定义规则、白名单与重扫存量记忆', async () => {
    const ipMem = await createMemory('出口节点公网地址 45.113.88.24', 'core://net')
    expect(ipMem.sensitiveFindings).toEqual([])

    const customMem = await createMemory('内部编号 PROJ-SECRET-12345678', 'core://proj')
    expect(customMem.sensitiveFindings).toEqual([])

    const getInitial = await send('GET', `/spaces/${ws.spaceId}/privacy`)
    expect(getInitial.status).toBe(200)
    expect((await getInitial.json()) as SpacePrivacySettings).toMatchObject({
      credentials: DEFAULT_SPACE_PRIVACY.credentials,
      pii: DEFAULT_SPACE_PRIVACY.pii,
    })

    // 开启 public_ip 并添加自定义规则
    const putRes = await send('PUT', `/spaces/${ws.spaceId}/privacy`, {
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

    // 显式触发重扫，存量两条记忆应被标出
    const rescanRes = await send('POST', `/spaces/${ws.spaceId}/privacy/rescan`)
    expect(rescanRes.status).toBe(200)
    expect(await rescanRes.json()).toMatchObject({ queued: false })

    const ipAfter = await getMemory('core://net')
    expect(ipAfter.sensitiveFindings?.map((f) => f.kind)).toContain('public_ip')

    const customAfter = await getMemory('core://proj')
    expect(
      customAfter.sensitiveFindings?.some(
        (f) => f.category === 'credential' && f.label === 'PROJ_TOKEN',
      ),
    ).toBe(true)

    // 加入白名单并重扫，应该清除命中的标记
    await send('PUT', `/spaces/${ws.spaceId}/privacy`, {
      allowlist: ['45.113.88.24', 'PROJ-SECRET-12345678'],
    })
    await send('POST', `/spaces/${ws.spaceId}/privacy/rescan`)

    const clearedIp = await getMemory('core://net')
    expect(clearedIp.sensitiveFindings).toEqual([])

    const clearedCustom = await getMemory('core://proj')
    expect(clearedCustom.sensitiveFindings).toEqual([])
  })

  it('实例隐私识别模型可配置、测试、参入空间检测，并在主密钥轮换时重包密钥', async () => {
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
      const saveRes = await send('PUT', '/settings/privacy-model', {
        mode: 'http',
        baseUrl,
        apiKey: 'ner-secret-key',
        minScore: 0.7,
      })
      expect(saveRes.status, await saveRes.clone().text()).toBe(200)
      const view = (await saveRes.json()) as PrivacyModelSettingsView
      expect(view).toMatchObject({ mode: 'http', baseUrl, hasApiKey: true, minScore: 0.7 })

      const testRes = await send('POST', '/settings/privacy-model/test', {})
      expect(testRes.status, await testRes.clone().text()).toBe(200)
      const testBody = (await testRes.json()) as PrivacyModelTestResult
      expect(testBody.ok).toBe(true)
      expect(testBody.findings).toBe(1)

      // 空间开启 usePrivacyModel 后写入记忆会调用模型并记录命中的 PII
      await send('PUT', `/spaces/${ws.spaceId}/privacy`, { usePrivacyModel: true })
      const mem = await createMemory('联系人张三在值班中', 'core://oncall')
      expect(mem.sensitiveFindings?.some((f) => f.category === 'pii' && f.kind === 'person')).toBe(
        true,
      )

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
      const retestRes = await appNext.request('/v1/settings/privacy-model/test', {
        method: 'POST',
        headers: {
          cookie: ws.cookie,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({}),
      })
      expect(retestRes.status).toBe(200)
      expect(((await retestRes.json()) as PrivacyModelTestResult).ok).toBe(true)

      const delRes = await appNext.request('/v1/settings/privacy-model', {
        method: 'DELETE',
        headers: { cookie: ws.cookie, 'sec-fetch-site': 'same-origin' },
      })
      expect(delRes.status).toBe(204)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('整理可以生成高召回记忆的提升优先级建议并应用到记忆上', async () => {
    await saveExtractionConfig(database.db, masterKey, {
      baseUrl: 'https://llm.example.com/v1',
      model: 'm',
    })
    const created = await send('POST', `/spaces/${ws.spaceId}/memories`, {
      uri: 'core://deploy-checklist',
      title: '发布前检查清单',
      content: '发布前必须跑完数据库迁移与冒烟检查',
      priority: 2,
    })
    expect(created.status).toBe(201)
    const mem = (await created.json()) as MemoryView

    // 写入累计 4 次召回统计
    await withSpace(database.db, ws.spaceId, (tx) =>
      tx.insert(memoryRecallStats).values({
        memoryId: mem.id,
        spaceId: ws.spaceId,
        count: 4,
        lastRecalledAt: new Date(),
      }),
    )

    const { model, calls } = fakeChatModel(async () =>
      JSON.stringify({
        suggestions: [
          {
            kind: 'promote',
            memories: ['M1'],
            targetPriority: 1,
            reason: '近阶段被频繁召回 4 次，提升为重要有助于稳定注入',
          },
        ],
      }),
    )

    const outcome = await dreamSpace(database.db, masterKey, {
      spaceId: ws.spaceId,
      runId: randomUUID(),
      trigger: 'manual',
      modelFor: () => model,
    })
    expect(outcome.outcome).toBe('done')
    expect(calls[0]![1]!.content).toContain('"recallCount":4')

    const listRes = await send('GET', `/spaces/${ws.spaceId}/dream/suggestions`)
    expect(listRes.status).toBe(200)
    const list = (await listRes.json()) as DreamSuggestionList
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ kind: 'promote', targetPriority: 1 })

    const applyRes = await send(
      'POST',
      `/spaces/${ws.spaceId}/dream/suggestions/${list.items[0]!.id}/apply`,
      {},
    )
    expect(applyRes.status, await applyRes.clone().text()).toBe(200)

    const after = await getMemory('core://deploy-checklist')
    expect(after.priority).toBe(1)

    const [row] = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(dreamSuggestions).where(eq(dreamSuggestions.id, list.items[0]!.id)),
    )
    expect(row?.status).toBe('applied')

    const events = await withSpace(database.db, ws.spaceId, (tx) =>
      tx.select().from(memoryEvents).where(eq(memoryEvents.memoryId, mem.id)),
    )
    expect(events.some((e) => e.eventType === 'update')).toBe(true)
  })
})
