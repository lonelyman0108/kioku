import { createRoute, z } from '@hono/zod-openapi'
import {
  DreamBindingView,
  EmbeddingRebuildResult,
  EmbeddingSettingsView,
  EmbeddingStatus,
  EmbeddingTestResult,
  ErrorResponse,
  ExtractionBindingView,
  InstanceAdvancedView,
  MasterKeyStatus,
  ModelChainTestResult,
  ModelProfileTestResult,
  ModelProviderView,
  ModelRegistryView,
  PrivacyBindingView,
  RecallSettings,
  RetentionResumed,
  RetentionSettings,
  RetentionView,
  UpdateDreamBinding,
  UpdateEmbeddingSettings,
  UpdateExtractionBinding,
  UpdateInstanceAdvanced,
  UpdatePrivacyBinding,
  UpsertModelProvider,
} from '@kioku/contracts'

import { requireConsole, requireInstanceAdmin } from '../auth/middleware'
import { bumpPrivacyModelRevisions, testPrivacyModel } from '../credential/privacy'
import { masterKeyStatus } from '../crypto/rotation'
import { EMBEDDING_DIMENSIONS } from '../db/schema'
import { embeddingCoverage } from '../embedding/coverage'
import { loadEmbeddingError } from '../embedding/errors'
import {
  clearNextEmbedding,
  embeddingSettingsView,
  loadEmbeddingModels,
  loadEmbeddingSetups,
  saveActiveEmbedding,
  saveNextEmbedding,
  switchEmbedding,
  type EmbeddingSetup,
} from '../embedding/settings'
import type { Deps } from '../http/env'
import { jsonBody, jsonResponse, router } from '../http/openapi'
import { endPause, retentionView, saveRetentionDays } from '../jobs/retention'
import { callChatProfile, callEmbeddingProfile } from '../models/execute'
import {
  createModelProvider,
  deleteModelProvider,
  loadDreamProfiles,
  loadExtractionProfiles,
  loadModelRegistryView,
  resolveProfileById,
  saveDreamBinding,
  saveExtractionBinding,
  savePrivacyBinding,
  updateModelProvider,
} from '../models/store'
import type { ResolvedChatProfile } from '../models/types'
import { loadRecallSettings, saveRecallSettings } from '../recall/retention'
import { saveInstanceAdvanced } from '../settings/advanced'
import { instanceAdvancedView } from '../settings/advancedViews'
import { SettingsInputError, unlocked } from '../settings/endpoint'
import { backupRoutes } from './backup'

const forbidden = jsonResponse('需要实例管理员', ErrorResponse)

// ---- 模型服务商与用途绑定 ----

const modelsView = createRoute({
  method: 'get',
  path: '/settings/models',
  tags: ['settings'],
  summary: '已配置的模型服务商、模型条目与各用途绑定（不返回 Key）',
  responses: { 200: jsonResponse('模型配置', ModelRegistryView), 403: forbidden },
})

const providerCreate = createRoute({
  method: 'post',
  path: '/settings/models/providers',
  tags: ['settings'],
  summary: '新增模型服务商及其模型条目',
  request: { body: jsonBody(UpsertModelProvider) },
  responses: {
    201: jsonResponse('已创建', ModelProviderView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const providerUpdate = createRoute({
  method: 'put',
  path: '/settings/models/providers/{providerId}',
  tags: ['settings'],
  summary: '修改模型服务商及其模型条目',
  request: {
    params: z.object({ providerId: z.string().min(1).max(32) }),
    body: jsonBody(UpsertModelProvider),
  },
  responses: {
    200: jsonResponse('已保存', ModelProviderView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const providerDelete = createRoute({
  method: 'delete',
  path: '/settings/models/providers/{providerId}',
  tags: ['settings'],
  summary: '删除未被引用的模型服务商',
  request: { params: z.object({ providerId: z.string().min(1).max(32) }) },
  responses: {
    204: { description: '已删除' },
    400: jsonResponse('无法删除', ErrorResponse),
    403: forbidden,
  },
})

const profileTest = createRoute({
  method: 'post',
  path: '/settings/models/profiles/{profileId}/test',
  tags: ['settings'],
  summary: '用已保存的服务商配置测试单个模型条目连通性',
  request: { params: z.object({ profileId: z.string().min(1).max(32) }) },
  responses: {
    200: jsonResponse('测试结果', ModelProfileTestResult),
    400: jsonResponse('找不到或解不开配置', ErrorResponse),
    403: forbidden,
  },
})

const extractionBindingUpdate = createRoute({
  method: 'put',
  path: '/settings/models/bindings/extraction',
  tags: ['settings'],
  summary: '设置抽取模型的对话模型链（按顺序 Fallback）；传空数组停止抽取',
  request: { body: jsonBody(UpdateExtractionBinding) },
  responses: {
    200: jsonResponse('已保存', ExtractionBindingView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const extractionBindingTest = createRoute({
  method: 'post',
  path: '/settings/models/bindings/extraction/test',
  tags: ['settings'],
  summary: '逐个测试已绑定的抽取模型连通性',
  responses: { 200: jsonResponse('测试结果', ModelChainTestResult), 403: forbidden },
})

const dreamBindingUpdate = createRoute({
  method: 'put',
  path: '/settings/models/bindings/dream',
  tags: ['settings'],
  summary: '设置整理（Dream）的模型绑定（沿用抽取或单独指定）',
  request: { body: jsonBody(UpdateDreamBinding) },
  responses: {
    200: jsonResponse('已保存', DreamBindingView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const dreamBindingTest = createRoute({
  method: 'post',
  path: '/settings/models/bindings/dream/test',
  tags: ['settings'],
  summary: '逐个测试已绑定的整理模型连通性',
  responses: { 200: jsonResponse('测试结果', ModelChainTestResult), 403: forbidden },
})

const privacyBindingUpdate = createRoute({
  method: 'put',
  path: '/settings/models/bindings/privacy',
  tags: ['settings'],
  summary: '配置隐私识别模型（关闭、HTTP 识别接口或已配置对话模型）',
  request: { body: jsonBody(UpdatePrivacyBinding) },
  responses: {
    200: jsonResponse('已保存', PrivacyBindingView),
    400: jsonResponse('无法保存', ErrorResponse),
    403: forbidden,
  },
})

const privacyBindingTest = createRoute({
  method: 'post',
  path: '/settings/models/bindings/privacy/test',
  tags: ['settings'],
  summary: '测试已保存的隐私识别模型连通性',
  responses: { 200: jsonResponse('测试结果', ModelChainTestResult), 403: forbidden },
})

// ---- 嵌入模型 ----

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
  summary: '修改正在用的模型的渠道引用；还没配置时是第一次配置，之后在后台为全部记忆生成向量',
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
  summary: '换模型，或改正在换过去的模型的渠道引用：后台补齐新模型的向量，补齐后切过去',
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

// ---- 其余实例设置 ----

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

const advancedView = createRoute({
  method: 'get',
  path: '/settings/advanced',
  tags: ['settings'],
  summary:
    '高级设置的实例默认：内置值、实例的覆盖、生效值、每项被几个空间与应用覆盖，以及提示词的固定部分',
  responses: { 200: jsonResponse('高级设置', InstanceAdvancedView), 403: forbidden },
})

const advancedUpdate = createRoute({
  method: 'put',
  path: '/settings/advanced',
  tags: ['settings'],
  summary:
    '修改高级设置的实例默认：只带要改的项，某项为 null 时恢复成内置值（补充为 null 或空白时去掉）',
  request: { body: jsonBody(UpdateInstanceAdvanced) },
  responses: {
    200: jsonResponse('高级设置', InstanceAdvancedView),
    400: jsonResponse('取值不对', ErrorResponse),
    403: forbidden,
  },
})

export function settingsRoutes(deps: Deps) {
  const app = router()
  app.use('/settings/*', requireConsole(deps), requireInstanceAdmin(deps))
  app.route('/', backupRoutes(deps))

  const embeddingView = async () => ({
    dimensions: EMBEDDING_DIMENSIONS,
    ...(await embeddingSettingsView(deps.db)),
  })
  const saving = async <T>(save: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await save() }
    } catch (err) {
      if (err instanceof SettingsInputError) return { ok: false as const, error: err.message }
      throw err
    }
  }

  return app
    .openapi(modelsView, async (c) => c.json(await loadModelRegistryView(deps.db), 200))
    .openapi(providerCreate, async (c) => {
      const saved = await saving(() =>
        createModelProvider(deps.db, deps.masterKey, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      return c.json(saved.value.provider, 201)
    })
    .openapi(providerUpdate, async (c) => {
      const { providerId } = c.req.valid('param')
      const saved = await saving(() =>
        updateModelProvider(deps.db, deps.masterKey, providerId, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      if (saved.value.affectsEmbedding) deps.embedder.invalidate()
      return c.json(saved.value.provider, 200)
    })
    .openapi(providerDelete, async (c) => {
      const { providerId } = c.req.valid('param')
      const saved = await saving(() => deleteModelProvider(deps.db, providerId))
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      return c.body(null, 204)
    })
    .openapi(profileTest, async (c) => {
      const { profileId } = c.req.valid('param')
      const resolved = await unlocked(() => resolveProfileById(deps.db, deps.masterKey, profileId))
      if (!resolved.ok) return c.json({ error: resolved.error }, 400)
      if (!resolved.value) return c.json({ error: '找不到这个模型条目' }, 400)
      const started = Date.now()
      if (resolved.value.kind === 'chat') {
        const p = resolved.value.profile
        try {
          await callChatProfile(p, {
            messages: [{ role: 'user', content: '这是连通性测试，只回复 ok。' }],
            what: '模型接口',
          })
          return c.json(
            {
              profileId: p.profileId,
              providerName: p.providerName,
              model: p.model,
              ok: true,
              latencyMs: Date.now() - started,
              error: null,
            },
            200,
          )
        } catch (err) {
          return c.json(
            {
              profileId: p.profileId,
              providerName: p.providerName,
              model: p.model,
              ok: false,
              latencyMs: Date.now() - started,
              error: (err as Error).message,
            },
            200,
          )
        }
      }
      const p = resolved.value.profile
      try {
        await callEmbeddingProfile(p, [PROBE])
        return c.json(
          {
            profileId: p.profileId,
            providerName: p.providerName,
            model: p.model,
            ok: true,
            latencyMs: Date.now() - started,
            error: null,
          },
          200,
        )
      } catch (err) {
        return c.json(
          {
            profileId: p.profileId,
            providerName: p.providerName,
            model: p.model,
            ok: false,
            latencyMs: Date.now() - started,
            error: (err as Error).message,
          },
          200,
        )
      }
    })
    .openapi(extractionBindingUpdate, async (c) => {
      const saved = await saving(() => saveExtractionBinding(deps.db, c.req.valid('json')))
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      return c.json(saved.value, 200)
    })
    .openapi(extractionBindingTest, async (c) => {
      const loaded = await unlocked(() => loadExtractionProfiles(deps.db, deps.masterKey))
      if (!loaded.ok) {
        return c.json(
          {
            ok: false,
            results: [
              {
                profileId: null,
                providerName: null,
                model: null,
                ok: false,
                latencyMs: 0,
                error: loaded.error,
              },
            ],
          },
          200,
        )
      }
      return c.json(await testChatChain(loaded.value, '尚未绑定抽取模型'), 200)
    })
    .openapi(dreamBindingUpdate, async (c) => {
      const saved = await saving(() => saveDreamBinding(deps.db, c.req.valid('json')))
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      return c.json(saved.value, 200)
    })
    .openapi(dreamBindingTest, async (c) => {
      const loaded = await unlocked(() => loadDreamProfiles(deps.db, deps.masterKey))
      if (!loaded.ok) {
        return c.json(
          {
            ok: false,
            results: [
              {
                profileId: null,
                providerName: null,
                model: null,
                ok: false,
                latencyMs: 0,
                error: loaded.error,
              },
            ],
          },
          200,
        )
      }
      return c.json(await testChatChain(loaded.value, '尚未绑定整理模型'), 200)
    })
    .openapi(privacyBindingUpdate, async (c) => {
      const saved = await saving(() =>
        savePrivacyBinding(deps.db, deps.masterKey, c.req.valid('json')),
      )
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      await bumpPrivacyModelRevisions(deps.db)
      void deps.jobs?.enqueueSensitiveRescan?.()
      return c.json(saved.value, 200)
    })
    .openapi(privacyBindingTest, async (c) =>
      c.json(await testPrivacyModel(deps.db, deps.masterKey), 200),
    )
    .openapi(view, async (c) => c.json(await embeddingView(), 200))
    .openapi(update, async (c) => {
      const saved = await saving(() => saveActiveEmbedding(deps.db, c.req.valid('json')))
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      deps.embedder.invalidate()
      void deps.jobs?.enqueueBackfill()
      return c.json({ dimensions: EMBEDDING_DIMENSIONS, ...saved.value }, 200)
    })
    .openapi(updateNext, async (c) => {
      const saved = await saving(() => saveNextEmbedding(deps.db, c.req.valid('json')))
      if (!saved.ok) return c.json({ error: saved.error }, 400)
      deps.embedder.invalidate()
      if (saved.value.replaced) void deps.jobs?.enqueuePrune()
      void deps.jobs?.enqueueSwitch()
      return c.json(
        { dimensions: EMBEDDING_DIMENSIONS, active: saved.value.active, next: saved.value.next },
        200,
      )
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
      void deps.jobs?.enqueuePrune()
      void deps.jobs?.enqueueBackfill()
      return c.json(await embeddingView(), 200)
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
      const progress = (setup: { model: string } | null) =>
        setup && { model: setup.model, embedded: embedded.get(setup.model) ?? 0 }
      return c.json(
        { eligible, active: progress(stored.active), next: progress(stored.next), lastError },
        200,
      )
    })
    .openapi(masterKey, async (c) => c.json(await masterKeyStatus(deps.db, deps.masterKey), 200))
    .openapi(recallView, async (c) => c.json(await loadRecallSettings(deps.db), 200))
    .openapi(recallUpdate, async (c) => {
      const value = c.req.valid('json')
      await saveRecallSettings(deps.db, value)
      return c.json(value, 200)
    })
    .openapi(advancedView, async (c) => c.json(await instanceAdvancedView(deps.db), 200))
    .openapi(advancedUpdate, async (c) => {
      await saveInstanceAdvanced(deps.db, c.req.valid('json'))
      return c.json(await instanceAdvancedView(deps.db), 200)
    })
    .openapi(retentionGet, async (c) => c.json(await retentionView(deps.db), 200))
    .openapi(retentionUpdate, async (c) => {
      await saveRetentionDays(deps.db, c.req.valid('json'))
      return c.json(await retentionView(deps.db), 200)
    })
    .openapi(retentionResume, async (c) => {
      await endPause(deps.db)
      const queued = deps.jobs ? await deps.jobs.enqueueCleanup() : false
      return c.json({ ...(await retentionView(deps.db)), queued }, 200)
    })
    .openapi(rebuild, async (c) => {
      const stored = await loadEmbeddingModels(deps.db)
      if (!stored.active) return c.json({ error: '尚未保存嵌入设置' }, 400)
      if (stored.next) void deps.jobs?.enqueueSwitch()
      const queued = deps.jobs ? await deps.jobs.enqueueBackfill() : false
      return queued
        ? c.json({ queued }, 202)
        : c.json({ error: '未能加入队列：服务未启动后台任务或入队失败，请稍后重试' }, 503)
    })
}

async function testChatChain(
  profiles: readonly ResolvedChatProfile[],
  emptyMessage: string,
): Promise<ModelChainTestResult> {
  if (!profiles.length) {
    return {
      ok: false,
      results: [
        {
          profileId: null,
          providerName: null,
          model: null,
          ok: false,
          latencyMs: 0,
          error: emptyMessage,
        },
      ],
    }
  }
  const results = await Promise.all(
    profiles.map(async (p) => {
      const started = Date.now()
      try {
        await callChatProfile(p, {
          messages: [{ role: 'user', content: '这是连通性测试，只回复 ok。' }],
          what: '模型接口',
        })
        return {
          profileId: p.profileId,
          providerName: p.providerName,
          model: p.model,
          ok: true,
          latencyMs: Date.now() - started,
          error: null,
        }
      } catch (err) {
        return {
          profileId: p.profileId,
          providerName: p.providerName,
          model: p.model,
          ok: false,
          latencyMs: Date.now() - started,
          error: (err as Error).message,
        }
      }
    }),
  )
  return { ok: results.some((r) => r.ok), results }
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

async function testChannels(setup: EmbeddingSetup | null) {
  if (!setup) return null
  const results = await Promise.all(
    setup.channels.map(async (channel) => {
      const started = Date.now()
      try {
        const [vector] = await callEmbeddingProfile(channel, [PROBE])
        return { vector: vector!, latencyMs: Date.now() - started, error: null }
      } catch (err) {
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
