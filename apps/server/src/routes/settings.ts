import { createRoute } from '@hono/zod-openapi'
import {
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingStatus,
  EmbeddingTestResult,
  ErrorResponse,
  ExtractionSettingsView,
  ExtractionTestResult,
  MasterKeyStatus,
  RecallSettings,
  RetentionResumed,
  RetentionSettings,
  RetentionView,
  UpdateEmbeddingSettings,
  UpdateExtractionSettings,
} from '@kioku/contracts'
import { requireConsole, requireInstanceAdmin } from '../auth/middleware'
import { masterKeyStatus } from '../crypto/rotation'
import { EMBEDDING_DIMENSIONS } from '../db/schema'
import { embeddingCoverage } from '../embedding/coverage'
import { loadEmbeddingError } from '../embedding/errors'
import { openAiEmbedder } from '../embedding/provider'
import {
  clearNextEmbedding,
  embeddingView,
  loadEmbeddingModels,
  loadEmbeddingSetups,
  saveActiveEmbedding,
  saveNextEmbedding,
  switchEmbedding,
  type EmbeddingSetup,
  type StoredEmbedding,
} from '../embedding/settings'
import { openAiChatModel } from '../extraction/provider'
import {
  clearExtractionConfig,
  extractionSettingsView,
  loadExtractionConfig,
  saveExtractionConfig,
} from '../extraction/settings'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { endPause, retentionView, saveRetentionDays } from '../jobs/retention'
import { loadRecallSettings, saveRecallSettings } from '../recall/retention'
import { SettingsInputError, unlocked } from '../settings/endpoint'
import { backupRoutes } from './backup'

const forbidden = jsonResponse('需要实例管理员', ErrorResponse)

const view = createRoute({
  method: 'get',
  path: '/settings/embedding',
  tags: ['settings'],
  summary: '嵌入模型设置（不返回 Key）',
  responses: { 200: jsonResponse('设置', EmbeddingSettingsView), 403: forbidden },
})

const update = createRoute({
  method: 'put',
  path: '/settings/embedding',
  tags: ['settings'],
  summary: '修改正在用的模型的渠道；还没配置时是第一次配置，之后在后台为全部记忆生成向量',
  request: { body: jsonBody(UpdateEmbeddingSettings) },
  responses: {
    200: jsonResponse('已保存', EmbeddingSettingsView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const updateNext = createRoute({
  method: 'put',
  path: '/settings/embedding/next',
  tags: ['settings'],
  summary: '换模型，或改正在换过去的模型的渠道：后台补齐新模型的向量，补齐后切过去',
  request: { body: jsonBody(UpdateEmbeddingSettings) },
  responses: {
    200: jsonResponse('已保存', EmbeddingSettingsView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const clearNext = createRoute({
  method: 'delete',
  path: '/settings/embedding/next',
  tags: ['settings'],
  summary: '放弃换模型：删掉新模型已经生成的向量',
  responses: {
    204: { description: '已放弃' },
    404: jsonResponse('没有正在换的模型', ErrorResponse),
    403: forbidden,
  },
})

const retryNext = createRoute({
  method: 'post',
  path: '/settings/embedding/next/retry',
  tags: ['settings'],
  summary: '马上再补一遍新模型的向量（例如修好了渠道之后），不用等定时任务',
  responses: {
    202: jsonResponse('已排队', EmbeddingRebuildResult),
    400: jsonResponse('没有正在换的模型', ErrorResponse),
    503: jsonResponse('没有排进队列（服务没有启动后台任务，或入队失败）', ErrorResponse),
    403: forbidden,
  },
})

const switchNow = createRoute({
  method: 'post',
  path: '/settings/embedding/switch',
  tags: ['settings'],
  summary: '不等补齐，现在就切到新模型；还没有新模型向量的记忆暂时只能靠全文与关键词召回',
  responses: {
    200: jsonResponse('已切换', EmbeddingSettingsView),
    400: jsonResponse('没有正在换的模型', ErrorResponse),
    403: forbidden,
  },
})

const test = createRoute({
  method: 'post',
  path: '/settings/embedding/test',
  tags: ['settings'],
  summary: '用已保存的设置逐个渠道请求一次嵌入，检查连通性、维度，以及是不是同一个模型',
  responses: {
    200: jsonResponse('测试结果', EmbeddingTestResult),
    400: jsonResponse('读不出设置', ErrorResponse),
    403: forbidden,
  },
})

const status = createRoute({
  method: 'get',
  path: '/settings/embedding/status',
  tags: ['settings'],
  summary: '整个实例的向量进度：应当有向量的记忆里，正在用的与正在换过去的模型各生成了多少',
  responses: { 200: jsonResponse('进度', EmbeddingStatus), 403: forbidden },
})

const masterKey = createRoute({
  method: 'get',
  path: '/settings/master-key',
  tags: ['settings'],
  summary: '主密钥的标识，以及轮换期间还剩多少条是旧主密钥包装的',
  responses: { 200: jsonResponse('主密钥', MasterKeyStatus), 403: forbidden },
})

const recallView = createRoute({
  method: 'get',
  path: '/settings/recall',
  tags: ['settings'],
  summary: '召回事件明细保留多少天',
  responses: { 200: jsonResponse('召回设置', RecallSettings), 403: forbidden },
})

const recallUpdate = createRoute({
  method: 'put',
  path: '/settings/recall',
  tags: ['settings'],
  summary: '修改召回事件明细的保留天数；更早的明细在下一次清理时并入累计统计后删除',
  request: { body: jsonBody(RecallSettings) },
  responses: { 200: jsonResponse('召回设置', RecallSettings), 403: forbidden },
})

const retentionGet = createRoute({
  method: 'get',
  path: '/settings/retention',
  tags: ['settings'],
  summary: '保留期：天数、从备份恢复之后的暂停，以及最近一次清理每一类删了多少',
  responses: { 200: jsonResponse('保留期', RetentionView), 403: forbidden },
})

const retentionUpdate = createRoute({
  method: 'put',
  path: '/settings/retention',
  tags: ['settings'],
  summary:
    '修改保留天数：之后的清理按新的天数硬删除。从备份恢复之后的暂停不结束，结束时间跟着天数变',
  request: { body: jsonBody(RetentionSettings) },
  responses: {
    200: jsonResponse('保留期', RetentionView),
    400: jsonResponse('天数不对', ErrorResponse),
    403: forbidden,
  },
})

const retentionResume = createRoute({
  method: 'post',
  path: '/settings/retention/resume',
  tags: ['settings'],
  summary:
    '提前结束暂停（从备份恢复之后、保留期第一次生效时），并马上排一次清理；queued 为是否排上了，没排上时下一次定时清理照样会做',
  responses: { 200: jsonResponse('保留期', RetentionResumed), 403: forbidden },
})

const rebuild = createRoute({
  method: 'post',
  path: '/settings/embedding/rebuild',
  tags: ['settings'],
  summary: '在后台检查全部记忆，补齐缺少或过时的向量；正在换模型时也接着补新模型的',
  responses: {
    202: jsonResponse('已排队', EmbeddingRebuildResult),
    400: jsonResponse('还没有保存嵌入设置', ErrorResponse),
    503: jsonResponse('没有排进队列（服务没有启动后台任务，或入队失败）', ErrorResponse),
    403: forbidden,
  },
})

const extractionView = createRoute({
  method: 'get',
  path: '/settings/extraction',
  tags: ['settings'],
  summary: '抽取模型设置（不返回 Key）',
  responses: { 200: jsonResponse('设置', ExtractionSettingsView), 403: forbidden },
})

const extractionUpdate = createRoute({
  method: 'put',
  path: '/settings/extraction',
  tags: ['settings'],
  summary: '修改抽取模型：从对话里抽取事实、写会话摘要用的 OpenAI 兼容接口',
  request: { body: jsonBody(UpdateExtractionSettings) },
  responses: {
    200: jsonResponse('已保存', ExtractionSettingsView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const extractionClear = createRoute({
  method: 'delete',
  path: '/settings/extraction',
  tags: ['settings'],
  summary: '清掉抽取模型的设置：抽取随即停止，对话缓冲到期后直接丢弃',
  responses: { 204: { description: '已清除' }, 403: forbidden },
})

const extractionTest = createRoute({
  method: 'post',
  path: '/settings/extraction/test',
  tags: ['settings'],
  summary: '用已保存的设置请求一次抽取模型，检查连通性',
  responses: { 200: jsonResponse('测试结果', ExtractionTestResult), 403: forbidden },
})

export function settingsRoutes(deps: Deps) {
  const app = router()
  app.use('/settings/*', requireConsole(deps), requireInstanceAdmin(deps))
  app.route('/', backupRoutes(deps))

  const viewOf = (stored: StoredEmbedding) => ({
    dimensions: EMBEDDING_DIMENSIONS,
    ...embeddingView(stored),
  })
  // 管理员填的设置不成立时返回 400 与原因，别的错误照常抛出
  const saving = async <T>(save: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await save() }
    } catch (err) {
      if (err instanceof SettingsInputError) return { ok: false as const, error: err.message }
      throw err
    }
  }
  return app
    .openapi(view, async (c) => c.json(viewOf(await loadEmbeddingModels(deps.db)), 200))
    .openapi(update, async (c) => {
      const saved = await saving(() =>
        saveActiveEmbedding(deps.db, deps.masterKey, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      deps.embedder.invalidate()
      void deps.jobs?.enqueueBackfill()
      return c.json(viewOf(saved.value), 200)
    })
    .openapi(updateNext, async (c) => {
      const saved = await saving(() =>
        saveNextEmbedding(deps.db, deps.masterKey, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      deps.embedder.invalidate()
      // 换成了另一个新模型：原来那个已经生成的向量用不上了
      if (saved.value.replaced) void deps.jobs?.enqueuePrune()
      void deps.jobs?.enqueueSwitch()
      return c.json(viewOf(saved.value.stored), 200)
    })
    .openapi(clearNext, async (c) => {
      const cleared = await clearNextEmbedding(deps.db)
      if (cleared === null) return c.json({ error: '没有正在更换的模型' }, 404)
      deps.embedder.invalidate()
      void deps.jobs?.enqueuePrune()
      return c.body(null, 204)
    })
    .openapi(retryNext, async (c) => {
      if (!(await loadEmbeddingModels(deps.db)).next) {
        return c.json({ error: '没有正在更换的模型' }, 400)
      }
      const queued = deps.jobs ? await deps.jobs.enqueueSwitch() : false
      return queued
        ? c.json({ queued }, 202)
        : c.json({ error: '未能加入队列：服务未启动后台任务或入队失败，请稍后重试' }, 503)
    })
    .openapi(switchNow, async (c) => {
      const { next } = await loadEmbeddingModels(deps.db)
      if (!next || (await switchEmbedding(deps.db, next.model)) === null) {
        return c.json({ error: '没有正在更换的模型' }, 400)
      }
      deps.embedder.invalidate()
      // 旧模型的向量删掉；还没有新模型向量的记忆接着补
      void deps.jobs?.enqueuePrune()
      void deps.jobs?.enqueueBackfill()
      return c.json(viewOf(await loadEmbeddingModels(deps.db)), 200)
    })
    .openapi(test, async (c) => {
      const setups = await unlocked(() => loadEmbeddingSetups(deps.db, deps.masterKey))
      if (!setups.ok) return c.json({ error: setups.error }, 400)
      const [active, next] = await Promise.all([
        testChannels(setups.value.active),
        testChannels(setups.value.next),
      ])
      return c.json({ active, next }, 200)
    })
    .openapi(status, async (c) => {
      const stored = await loadEmbeddingModels(deps.db)
      const models = [stored.active, stored.next].flatMap((s) => (s ? [s.model] : []))
      const [{ eligible, embedded }, lastError] = await Promise.all([
        embeddingCoverage(deps.db, models),
        loadEmbeddingError(deps.db),
      ])
      const progress = (setup: StoredEmbedding['active']) =>
        setup && { model: setup.model, embedded: embedded.get(setup.model) ?? 0 }
      return c.json(
        { eligible, active: progress(stored.active), next: progress(stored.next), lastError },
        200,
      )
    })
    .openapi(extractionView, async (c) => c.json(await extractionSettingsView(deps.db), 200))
    .openapi(extractionUpdate, async (c) => {
      const saved = await saving(() =>
        saveExtractionConfig(deps.db, deps.masterKey, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      return c.json(saved.value, 200)
    })
    .openapi(extractionClear, async (c) => {
      await clearExtractionConfig(deps.db)
      return c.body(null, 204)
    })
    .openapi(extractionTest, async (c) => {
      const started = Date.now()
      const result = (error: string | null) =>
        c.json({ ok: error === null, latencyMs: Date.now() - started, error }, 200)
      const config = await unlocked(() => loadExtractionConfig(deps.db, deps.masterKey))
      if (!config.ok) return result(config.error)
      if (!config.value) return result('尚未保存抽取模型设置')
      try {
        await openAiChatModel(config.value).complete([
          { role: 'user', content: '这是连通性测试，只回复 ok。' },
        ])
        return result(null)
      } catch (err) {
        // 这里只有请求模型：模型报的错要让管理员看到，它的文字不带 Key
        return result((err as Error).message)
      }
    })
    .openapi(masterKey, async (c) => c.json(await masterKeyStatus(deps.db, deps.masterKey), 200))
    .openapi(recallView, async (c) => c.json(await loadRecallSettings(deps.db), 200))
    .openapi(recallUpdate, async (c) => {
      const value = c.req.valid('json')
      await saveRecallSettings(deps.db, value)
      return c.json(value, 200)
    })
    .openapi(retentionGet, async (c) => c.json(await retentionView(deps.db), 200))
    .openapi(retentionUpdate, async (c) => {
      await saveRetentionDays(deps.db, c.req.valid('json'))
      return c.json(await retentionView(deps.db), 200)
    })
    .openapi(retentionResume, async (c) => {
      await endPause(deps.db)
      // 只等排队、不等清理做完；排不上时如实告诉界面，下一次定时清理（每小时）照样会做
      const queued = deps.jobs ? await deps.jobs.enqueueCleanup() : false
      return c.json({ ...(await retentionView(deps.db)), queued }, 200)
    })
    .openapi(rebuild, async (c) => {
      const stored = await loadEmbeddingModels(deps.db)
      if (!stored.active) return c.json({ error: '尚未保存嵌入设置' }, 400)
      if (stored.next) void deps.jobs?.enqueueSwitch()
      // 入队失败时如实返回，状态码也不报成已接受，不让管理员以为补齐已经在跑
      const queued = deps.jobs ? await deps.jobs.enqueueBackfill() : false
      return queued
        ? c.json({ queued }, 202)
        : c.json({ error: '未能加入队列：服务未启动后台任务或入队失败，请稍后重试' }, 503)
    })
}

const PROBE = '连通性测试'

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// 一组渠道各请求一次同一段文本：维度不对算失败；和第一个通了的渠道比相似度，看是不是同一个模型
async function testChannels(setup: EmbeddingSetup | null) {
  if (!setup) return null
  const results = await Promise.all(
    setup.channels.map(async (channel) => {
      const started = Date.now()
      try {
        const [vector] = await openAiEmbedder(channel).embed([PROBE])
        return { vector: vector!, latencyMs: Date.now() - started, error: null }
      } catch (err) {
        // 模型报的错要让管理员看到，它的文字不带 Key
        return { vector: null, latencyMs: Date.now() - started, error: (err as Error).message }
      }
    }),
  )
  const reference = results.find((r) => r.vector)?.vector
  return results.map((r) => ({
    ok: r.vector !== null,
    latencyMs: r.latencyMs,
    error: r.error,
    similarity:
      r.vector && reference && r.vector !== reference
        ? Math.round(cosine(reference, r.vector) * 10_000) / 10_000
        : null,
  }))
}
