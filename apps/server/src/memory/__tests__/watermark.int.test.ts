import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CredentialService } from '../../credential/service'
import type { Database } from '../../db/client'
import { dreamSuggestions, entries, entryEvents, settings } from '../../db/schema'
import { suggestionFingerprint } from '../../extraction/dream'
import {
  carryForwardTidyCheckedVersions,
  CHAT_LLM_SETTING_KEY,
  loadTidyCheckedVersions,
  markTidyCheckedVersion,
  mergeTidyCheckedVersions,
  saveModelEndpoint,
  TIDY_CHECKED_SETTING_KEY,
} from '../../models/store'
import {
  entryInput,
  openTestDatabase,
  resetDatabase,
  testDatabaseUrl,
  testMasterKey,
} from '../../testing/db'
import { startFakeOpenAi, type FakeOpenAiServer } from '../../testing/fakeOpenAi'
import { EntryService } from '../service'

const consoleScope = { kind: 'console' as const, accountId: 'acc', sessionId: 'sess' }

describe.skipIf(!testDatabaseUrl)('整理水位顺延与 tidy_checked_versions 集成测试', () => {
  let database: Database
  let fakeAi: FakeOpenAiServer

  beforeAll(async () => {
    database = await openTestDatabase()
    fakeAi = await startFakeOpenAi()
  })

  beforeEach(async () => {
    await resetDatabase(database)
    fakeAi.setChatHandler(() => JSON.stringify({ needed: false }))
  })

  afterAll(async () => {
    await fakeAi.close()
    await database.close()
  })

  function createService() {
    const masterKey = testMasterKey()
    return {
      masterKey,
      entrySvc: new EntryService(
        database.db,
        masterKey,
        new CredentialService(database.db, masterKey),
        null,
      ),
    }
  }

  async function readEntryWatermarks(id: string) {
    const [row] = await database.db
      .select({
        version: entries.version,
        dreamCheckedVersion: entries.dreamCheckedVersion,
      })
      .from(entries)
      .where(eq(entries.id, id))
      .limit(1)
    return row!
  }

  async function markDreamChecked(id: string, version: number) {
    await database.db
      .update(entries)
      .set({ dreamCheckedVersion: version })
      .where(eq(entries.id, id))
  }

  it('markTidyCheckedVersion 与 carryForwardTidyCheckedVersions 幂等、零空写且并发安全', async () => {
    // 未建行时调用顺延不应写入 settings
    await carryForwardTidyCheckedVersions(database.db, [
      { id: 'entry-a', fromVersion: 1, toVersion: 2 },
    ])
    const rowsBefore = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    expect(rowsBefore).toHaveLength(0)

    // 并发首次写入不丢 key，且单调递增不回退
    await Promise.all([
      markTidyCheckedVersion(database.db, 'entry-a', 2),
      markTidyCheckedVersion(database.db, 'entry-b', 3),
    ])
    await markTidyCheckedVersion(database.db, 'entry-a', 1)
    expect(await loadTidyCheckedVersions(database.db)).toEqual({ 'entry-a': 2, 'entry-b': 3 })

    // 无命中时不写表（updatedAt 不变）
    const [beforeNoop] = await database.db
      .select({ updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    await carryForwardTidyCheckedVersions(database.db, [
      { id: 'entry-a', fromVersion: 1, toVersion: 2 },
      { id: 'entry-c', fromVersion: 1, toVersion: 2 },
    ])
    const [afterNoop] = await database.db
      .select({ updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    expect(afterNoop!.updatedAt.getTime()).toBe(beforeNoop!.updatedAt.getTime())

    // 命中项顺延，未命中项保持原值
    await carryForwardTidyCheckedVersions(database.db, [
      { id: 'entry-a', fromVersion: 2, toVersion: 3 },
      { id: 'entry-b', fromVersion: 2, toVersion: 3 },
    ])
    expect(await loadTidyCheckedVersions(database.db)).toEqual({ 'entry-a': 3, 'entry-b': 3 })
  })

  it('mergeTidyCheckedVersions 并发合并时不覆盖并发 markTidyCheckedVersion，且仅裁剪显式失效键', async () => {
    // 冷启动仅传 pruneIds 不应空写 settings 行
    await mergeTidyCheckedVersions(database.db, new Map(), new Set(['stale-1']))
    const rowsBefore = await database.db
      .select()
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    expect(rowsBefore).toHaveLength(0)

    await markTidyCheckedVersion(database.db, 'stale-1', 1)
    await markTidyCheckedVersion(database.db, 'shared', 4)

    // 并发执行批量 merge（带较低旧版本 shared:2、新条目 batch-1:1、裁剪 stale-1）与单条 mark（新条目 concurrent-new:1、升级 shared:5）
    await Promise.all([
      mergeTidyCheckedVersions(
        database.db,
        new Map([
          ['shared', 2],
          ['batch-1', 1],
        ]),
        new Set(['stale-1']),
      ),
      markTidyCheckedVersion(database.db, 'concurrent-new', 1),
      markTidyCheckedVersion(database.db, 'shared', 5),
    ])

    expect(await loadTidyCheckedVersions(database.db)).toEqual({
      shared: 5,
      'batch-1': 1,
      'concurrent-new': 1,
    })

    // 无实际变化时不刷新 settings.updatedAt
    const [beforeNoop] = await database.db
      .select({ updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    await mergeTidyCheckedVersions(
      database.db,
      new Map([['shared', 3]]),
      new Set(['nonexistent-stale']),
    )
    const [afterNoop] = await database.db
      .select({ updatedAt: settings.updatedAt })
      .from(settings)
      .where(eq(settings.key, TIDY_CHECKED_SETTING_KEY))
    expect(afterNoop!.updatedAt.getTime()).toBe(beforeNoop!.updatedAt.getTime())
  })

  it('previewSingleTidy 无改动登记规范水位，applySingleTidy 顺延已检水位并写入 tidy:single 来源', async () => {
    const { masterKey, entrySvc } = createService()
    await saveModelEndpoint(database.db, masterKey, CHAT_LLM_SETTING_KEY, {
      baseUrl: fakeAi.baseUrl,
      model: 'fake-chat',
      apiKey: 'sk-chat',
      enabled: true,
    })

    const cleanEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '规范良好的记忆',
        summary: '结构清晰。',
        content: '正文简洁明了。',
      }),
    )
    const dirtyHeadingEntry = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '重复标题记忆',
        content: '# 重复标题记忆\n\n这里是正文。',
      }),
    )

    fakeAi.setChatHandler(() => JSON.stringify({ needed: false, reason: '结构良好' }))

    // needed=false 且无预清洗修复 -> 写入 tidy_checked_versions
    const cleanPreview = await entrySvc.previewSingleTidy(cleanEntry.entry.shortId)
    expect(cleanPreview.needed).toBe(false)
    expect(cleanPreview.preCleanedFixes).toEqual([])
    expect((await loadTidyCheckedVersions(database.db))[cleanEntry.entry.id]).toBe(1)

    // 存在预清洗修复时即使模型判 not_needed 也不提前登记
    const dirtyPreview = await entrySvc.previewSingleTidy(dirtyHeadingEntry.entry.shortId)
    expect(dirtyPreview.needed).toBe(true)
    expect(dirtyPreview.preCleanedFixes).toContain('strip_duplicate_heading')
    expect((await loadTidyCheckedVersions(database.db))[dirtyHeadingEntry.entry.id]).toBeUndefined()

    // 已通过增量整理的词条应用单条规范：顺延 dreamCheckedVersion、写入 tidy:single、登记 tidy_checked_versions
    await markDreamChecked(dirtyHeadingEntry.entry.id, dirtyHeadingEntry.entry.version)
    const applied = await entrySvc.applySingleTidy(consoleScope, dirtyHeadingEntry.entry.shortId, {
      expectedVersion: dirtyHeadingEntry.entry.version,
      title: dirtyHeadingEntry.entry.title,
      summary: '整理后的现行概要',
      content: '这里是正文。',
      archivedNotes: [{ note: '归档旧日志条目' }],
      applyArchivedNotes: true,
    })
    expect(applied.entry?.entry.version).toBe(2)
    expect(await readEntryWatermarks(dirtyHeadingEntry.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[dirtyHeadingEntry.entry.id]).toBe(2)

    const events = await database.db
      .select({ eventType: entryEvents.eventType, actor: entryEvents.actor })
      .from(entryEvents)
      .where(eq(entryEvents.entryId, dirtyHeadingEntry.entry.id))
    expect(events.filter((e) => e.eventType === 'archive_note').map((e) => e.actor)).toEqual([
      'tidy:single',
    ])
    expect(events.filter((e) => e.eventType === 'update').map((e) => e.actor)).toEqual([
      'tidy:single',
    ])
    expect(applied.entry?.recentHistory?.[0]?.actorMeta).toEqual({
      kind: 'console',
      label: '本人 · 规范整理',
      runtimeFamily: null,
    })

    // 未通过增量整理的词条应用单条规范：绝不提前顺延 dreamCheckedVersion；若跳过正文清洗且仍留正文卫生问题则不登记规范水位
    const uncheckedWithChangelog = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '长标题 2026-01-01 更新记录',
        content: '现行规则。\n\n## 更新日志\n- 2026-01-01 首次写入\n- 2026-01-02 二次修改',
      }),
    )
    await entrySvc.applySingleTidy(consoleScope, uncheckedWithChangelog.entry.shortId, {
      expectedVersion: uncheckedWithChangelog.entry.version,
      title: '现行规则',
      summary: null,
      content: uncheckedWithChangelog.entry.content,
    })
    expect(await readEntryWatermarks(uncheckedWithChangelog.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 0,
    })
    expect(
      (await loadTidyCheckedVersions(database.db))[uncheckedWithChangelog.entry.id],
    ).toBeUndefined()

    // 只勾正文清洗但跳过脏标题/过多主题时，更新后仍存在卫生告警，不应误标 tidy_checked_versions
    const partialBodyOnly = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '部署约定 2026-01-01 更新',
        content: '现行规则。\n\n## 更新日志\n- 2026-01-01 初版\n- 2026-01-02 调整',
        topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'],
      }),
    )
    await markDreamChecked(partialBodyOnly.entry.id, 1)
    await entrySvc.applySingleTidy(consoleScope, partialBodyOnly.entry.shortId, {
      expectedVersion: 1,
      title: partialBodyOnly.entry.title,
      summary: '现行规则概要。',
      content: '现行规则。',
    })
    expect(await readEntryWatermarks(partialBodyOnly.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[partialBodyOnly.entry.id]).toBeUndefined()
  })

  it('applyHygieneSweep 与手工 update 按规则顺延或保留水位', async () => {
    const { entrySvc } = createService()

    const checkedSweep = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待清洗已检记忆',
        summary: '已有现行概要。',
        content: '# 待清洗已检记忆\n\n正文内容。',
      }),
    )
    const uncheckedSweep = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '待清洗未检记忆',
        content: '# 待清洗未检记忆\n\n正文内容。',
      }),
    )
    await markDreamChecked(checkedSweep.entry.id, 1)
    await markTidyCheckedVersion(database.db, checkedSweep.entry.id, 1)
    await markTidyCheckedVersion(database.db, uncheckedSweep.entry.id, 1)

    const sweepRes = await entrySvc.applyHygieneSweep()
    expect(sweepRes.applied).toBe(2)

    expect(await readEntryWatermarks(checkedSweep.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect(await readEntryWatermarks(uncheckedSweep.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 0,
    })
    expect(await loadTidyCheckedVersions(database.db)).toEqual({
      [checkedSweep.entry.id]: 2,
      [uncheckedSweep.entry.id]: 2,
    })

    // 手工 update 仅改场景与 bootMode（已有概要，未引入常驻缺概要）：不顺延 dreamCheckedVersion，但顺延 tidy_checked_versions
    await entrySvc.update(consoleScope, checkedSweep.entry.shortId, {
      envs: ['mac'],
      bootMode: 'index',
    })
    expect(await readEntryWatermarks(checkedSweep.entry.id)).toEqual({
      version: 3,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[checkedSweep.entry.id]).toBe(3)

    // 手工 update 将无概要词条设为常驻：新引入常驻缺概要，不得顺延 tidy_checked_versions
    await entrySvc.update(consoleScope, uncheckedSweep.entry.shortId, {
      bootMode: 'index',
    })
    expect((await loadTidyCheckedVersions(database.db))[uncheckedSweep.entry.id]).toBe(2)

    // 手工 update 改正文：两个水位均不顺延
    await markDreamChecked(checkedSweep.entry.id, 3)
    await entrySvc.update(consoleScope, checkedSweep.entry.shortId, {
      content: '人工补充了新事实。',
    })
    expect(await readEntryWatermarks(checkedSweep.entry.id)).toEqual({
      version: 4,
      dreamCheckedVersion: 3,
    })
    expect((await loadTidyCheckedVersions(database.db))[checkedSweep.entry.id]).toBe(3)
  })

  it('applySuggestion 各分支按场景与内容覆写规则精确维护两个水位', async () => {
    const { entrySvc } = createService()

    async function insertSuggestion(values: {
      kind:
        | 'tidy'
        | 'link_entries'
        | 'adjust_boot_mode'
        | 'update'
        | 'merge_duplicates'
        | 'distill_episode'
      entryIds: string[]
      entryVersions: number[]
      keepId?: string | null
      proposedTitle?: string | null
      proposedContent?: string | null
      proposedEnvs?: string[] | null
      proposedLinks?: Array<{ targetShortId: string; relation?: string | null }> | null
      proposedBootMode?: 'none' | 'index' | 'full' | null
      discriminator?: string
    }) {
      const fp = suggestionFingerprint(
        values.kind,
        values.entryIds,
        values.entryVersions,
        values.discriminator,
      )
      const [row] = await database.db
        .insert(dreamSuggestions)
        .values({
          kind: values.kind,
          entryIds: values.entryIds,
          entryVersions: values.entryVersions,
          keepId: values.keepId ?? null,
          proposedTitle: values.proposedTitle ?? null,
          proposedContent: values.proposedContent ?? null,
          proposedEnvs: values.proposedEnvs ?? null,
          proposedLinks: values.proposedLinks ?? null,
          proposedBootMode: values.proposedBootMode ?? null,
          reason: '测试建议',
          fingerprint: fp,
          status: 'pending',
        })
        .returning({ id: dreamSuggestions.id })
      return row!.id
    }

    // 1. tidy（无覆写 -> 顺延 dream + 登记 tidy）
    const tidyTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '旧标题', content: '旧正文' }),
    )
    await markDreamChecked(tidyTarget.entry.id, 1)
    const tidyId = await insertSuggestion({
      kind: 'tidy',
      entryIds: [tidyTarget.entry.id],
      entryVersions: [1],
      proposedTitle: '新标题',
      proposedContent: '规范后正文',
    })
    await entrySvc.applySuggestion(tidyId, {})
    expect(await readEntryWatermarks(tidyTarget.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[tidyTarget.entry.id]).toBe(2)

    // 1b. tidy 取消勾选正文（传原文 content）且跳过脏标题：不判人工重写正文（顺延 dream），但因仍残留脏标题不标 tidy
    const tidyPartial = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '规范测试 2026-01-01 历史',
        content: '简短稳定正文。',
      }),
    )
    await markDreamChecked(tidyPartial.entry.id, 1)
    const tidyPartialId = await insertSuggestion({
      kind: 'tidy',
      entryIds: [tidyPartial.entry.id],
      entryVersions: [1],
      proposedTitle: '规范测试',
      proposedContent: '建议微调正文。',
    })
    await entrySvc.applySuggestion(tidyPartialId, {
      title: tidyPartial.entry.title,
      content: tidyPartial.entry.content,
    })
    expect(await readEntryWatermarks(tidyPartial.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[tidyPartial.entry.id]).toBeUndefined()

    // 1c. tidy 人工覆写 content -> 不顺延 dream，也不登记新 tidy 水位
    const tidyOverrideId = await insertSuggestion({
      kind: 'tidy',
      entryIds: [tidyTarget.entry.id],
      entryVersions: [2],
      proposedContent: '建议正文',
    })
    await entrySvc.applySuggestion(tidyOverrideId, { content: '人工改写的正文' })
    expect(await readEntryWatermarks(tidyTarget.entry.id)).toEqual({
      version: 3,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[tidyTarget.entry.id]).toBe(2)

    // 2. link_entries -> 顺延 dream 与 tidy
    const linkAnchor = await entrySvc.create(
      consoleScope,
      entryInput({ title: '主记忆', content: '主记忆正文。' }),
    )
    const linkPeer = await entrySvc.create(
      consoleScope,
      entryInput({ title: '关联记忆', content: '关联记忆正文。' }),
    )
    await markDreamChecked(linkAnchor.entry.id, 1)
    await markTidyCheckedVersion(database.db, linkAnchor.entry.id, 1)
    const linkId = await insertSuggestion({
      kind: 'link_entries',
      entryIds: [linkAnchor.entry.id],
      entryVersions: [1],
      proposedLinks: [{ targetShortId: linkPeer.entry.shortId, relation: '参考' }],
    })
    await entrySvc.applySuggestion(linkId, {})
    expect(await readEntryWatermarks(linkAnchor.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[linkAnchor.entry.id]).toBe(2)

    // 3. adjust_boot_mode（有概要且未改元信息 -> 顺延 dream 与 tidy；无概要常驻或改写 summary/topics -> 不顺延 tidy）
    const bootTarget = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '常驻调整目标',
        summary: '已有现行概要。',
        content: '常驻正文。',
        bootMode: 'full',
      }),
    )
    await markDreamChecked(bootTarget.entry.id, 1)
    await markTidyCheckedVersion(database.db, bootTarget.entry.id, 1)
    const bootSugId = await insertSuggestion({
      kind: 'adjust_boot_mode',
      entryIds: [bootTarget.entry.id],
      entryVersions: [1],
      proposedBootMode: 'index',
    })
    await entrySvc.applySuggestion(bootSugId, {})
    expect(await readEntryWatermarks(bootTarget.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[bootTarget.entry.id]).toBe(2)

    // adjust_boot_mode 若通过 overrides 清空 summary 或修改 topics，不顺延 tidy_checked_versions
    const bootClearSummaryId = await insertSuggestion({
      kind: 'adjust_boot_mode',
      entryIds: [bootTarget.entry.id],
      entryVersions: [2],
      proposedBootMode: 'index',
      discriminator: 'clear-summary',
    })
    await entrySvc.applySuggestion(bootClearSummaryId, { summary: null })
    expect(await readEntryWatermarks(bootTarget.entry.id)).toEqual({
      version: 3,
      dreamCheckedVersion: 3,
    })
    expect((await loadTidyCheckedVersions(database.db))[bootTarget.entry.id]).toBe(2)

    const bootNoSummary = await entrySvc.create(
      consoleScope,
      entryInput({ title: '无概要升常驻', content: '短正文。', bootMode: 'none' }),
    )
    await markDreamChecked(bootNoSummary.entry.id, 1)
    await markTidyCheckedVersion(database.db, bootNoSummary.entry.id, 1)
    const bootPromoteNoSummaryId = await insertSuggestion({
      kind: 'adjust_boot_mode',
      entryIds: [bootNoSummary.entry.id],
      entryVersions: [1],
      proposedBootMode: 'index',
    })
    await entrySvc.applySuggestion(bootPromoteNoSummaryId, {})
    expect(await readEntryWatermarks(bootNoSummary.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect((await loadTidyCheckedVersions(database.db))[bootNoSummary.entry.id]).toBe(1)

    // 4. update（采纳建议 -> 顺延 dream；若改动场景或人工覆写正文 -> 不顺延 dream）
    const updTarget = await entrySvc.create(
      consoleScope,
      entryInput({ title: '事实更新目标', content: '旧端口 8080。' }),
    )
    await markDreamChecked(updTarget.entry.id, 1)
    const updOkId = await insertSuggestion({
      kind: 'update',
      entryIds: [updTarget.entry.id],
      entryVersions: [1],
      proposedContent: '新端口 9090。',
    })
    await entrySvc.applySuggestion(updOkId, {})
    expect(await readEntryWatermarks(updTarget.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })

    const updSceneId = await insertSuggestion({
      kind: 'update',
      entryIds: [updTarget.entry.id],
      entryVersions: [2],
      proposedContent: '新端口 9091。',
      proposedEnvs: ['mac'],
    })
    await entrySvc.applySuggestion(updSceneId, {})
    expect(await readEntryWatermarks(updTarget.entry.id)).toEqual({
      version: 3,
      dreamCheckedVersion: 2,
    })

    // 5. merge_duplicates：全源已检时 keep 顺延，且被重定向反链 refRow 独立顺延 dream 与 tidy
    const keepA = await entrySvc.create(
      consoleScope,
      entryInput({ title: '保留项 A', content: '合并保留内容。', realms: ['work'] }),
    )
    const dupB = await entrySvc.create(
      consoleScope,
      entryInput({ title: '重复项 B', content: '重复补充内容。', realms: ['work'] }),
    )
    const refChecked = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '引用方已检',
        content: `详情见 [[${dupB.entry.shortId}|重复项 B]]。`,
      }),
    )
    const refUnchecked = await entrySvc.create(
      consoleScope,
      entryInput({
        title: '引用方未检',
        content: `另外参考 [[${dupB.entry.shortId}]]。`,
      }),
    )
    await markDreamChecked(keepA.entry.id, 1)
    await markDreamChecked(dupB.entry.id, 1)
    await markDreamChecked(refChecked.entry.id, 1)
    await markTidyCheckedVersion(database.db, refChecked.entry.id, 1)
    await markTidyCheckedVersion(database.db, refUnchecked.entry.id, 1)

    const mergeOkId = await insertSuggestion({
      kind: 'merge_duplicates',
      entryIds: [keepA.entry.id, dupB.entry.id],
      entryVersions: [1, 1],
      keepId: keepA.entry.id,
      proposedContent: '合并后的完整内容。',
    })
    const mergeRes = await entrySvc.applySuggestion(mergeOkId, {})
    expect(mergeRes.redirectedBacklinkCount).toBe(2)
    expect(await readEntryWatermarks(keepA.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect(await readEntryWatermarks(refChecked.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 2,
    })
    expect(await readEntryWatermarks(refUnchecked.entry.id)).toEqual({
      version: 2,
      dreamCheckedVersion: 0,
    })
    const tidyAfterMerge = await loadTidyCheckedVersions(database.db)
    expect(tidyAfterMerge[refChecked.entry.id]).toBe(2)
    expect(tidyAfterMerge[refUnchecked.entry.id]).toBe(2)

    // 5b. merge_duplicates 若有一条被合并源未检，则 keep 不顺延
    const dupUnchecked = await entrySvc.create(
      consoleScope,
      entryInput({ title: '未检重复项 C', content: '尚未经过增量整理。', realms: ['work'] }),
    )
    const mergeUncheckedId = await insertSuggestion({
      kind: 'merge_duplicates',
      entryIds: [keepA.entry.id, dupUnchecked.entry.id],
      entryVersions: [2, 1],
      keepId: keepA.entry.id,
      proposedContent: '再次合并后的内容。',
    })
    await entrySvc.applySuggestion(mergeUncheckedId, {})
    expect(await readEntryWatermarks(keepA.entry.id)).toEqual({
      version: 3,
      dreamCheckedVersion: 2,
    })

    // 6. distill_episode：新建正式记忆保持 dreamCheckedVersion = 0
    const ep = await entrySvc.writeEpisode({
      title: '会话提炼源',
      content: '确认使用严格类型校验。',
      realms: ['work'],
    })
    const distillId = await insertSuggestion({
      kind: 'distill_episode',
      entryIds: [ep.id],
      entryVersions: [1],
      proposedTitle: '类型校验规范',
      proposedContent: '项目统一启用严格类型校验。',
    })
    const distilled = await entrySvc.applySuggestion(distillId, {})
    expect(await readEntryWatermarks(distilled.entry!.id)).toEqual({
      version: 1,
      dreamCheckedVersion: 0,
    })
  })
})
