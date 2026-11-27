import {
  checkCaptureIntegrity,
  normalizeShortId,
  type HygieneSweepFixKind,
  type SingleTidyPreviewResponse,
} from '@kioku/contracts'
import { and, asc, eq, isNull } from 'drizzle-orm'

import type { MasterKey } from '../crypto/keyring'
import type { Db } from '../db/client'
import { entries } from '../db/schema'
import { MemoryError } from '../memory/errors'
import { buildUniqueSlugIndex, computeDeterministicFixes } from '../memory/hygieneSweep'
import { chatComplete } from '../models/client'
import { CHAT_LLM_SETTING_KEY, loadResolvedModel } from '../models/store'
import { CaptureAbortedError } from './capture'
import { computeDynamicOutputTokens, toPromptItem } from './dream'
import { buildSemanticRepairMessages, buildTidyMessages, evaluateTidyResponse } from './dreamPrompt'

const SINGLE_TIDY_CONTENT_LIMIT = 16_000
const SINGLE_TIDY_TIMEOUT_MS = 240_000
const SINGLE_TIDY_OUTPUT_TOKENS_MIN = 6_000
const SINGLE_TIDY_OUTPUT_TOKENS_MAX = 16_384

export function computeSingleTidyMaxTokens(contentLength: number): number {
  return computeDynamicOutputTokens(contentLength, {
    min: SINGLE_TIDY_OUTPUT_TOKENS_MIN,
    max: SINGLE_TIDY_OUTPUT_TOKENS_MAX,
    overhead: 2_000,
  })
}

export type SingleTidyStage = 'preclean' | 'llm' | 'verify'

export interface PreviewSingleTidyOptions {
  signal?: AbortSignal | undefined
  onStage?: ((stage: SingleTidyStage, message: string) => void) | undefined
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

function buildRepairFeedback(evaluated: {
  reason: string
  missingLinks?: string[] | undefined
  missingCreds?: string[] | undefined
}): string {
  const missing = [...(evaluated.missingLinks ?? []), ...(evaluated.missingCreds ?? [])]
  if (missing.length) {
    return `上次生成的正文遗漏了原文必须保留的引用标记：${missing.join('、')}。请完整保留所有双链与凭据占位符并重新输出单个合法 JSON 对象。`
  }
  return `上次输出解析失败（${evaluated.reason}）。请严格只输出单个符合要求的合法 JSON 对象，不要包含任何额外说明。`
}

// 主动单条快速规范预览：跳过静态正则门槛与全局 dream 锁，先做内存确定性预清洗，再调用对话模型生成规范方案
export async function previewSingleTidy(
  db: Db,
  masterKey: MasterKey | null,
  rawShortId: string,
  options: PreviewSingleTidyOptions = {},
): Promise<SingleTidyPreviewResponse> {
  const shortId = normalizeShortId(rawShortId)
  const [target] = await db
    .select()
    .from(entries)
    .where(and(eq(entries.shortId, shortId), isNull(entries.deletedAt)))
    .limit(1)
  if (!target) throw new MemoryError(404, '记忆不存在或已移入回收站')
  if (target.kind !== 'entry') {
    throw new MemoryError(400, '会话摘要不支持直接规范整理，请先提炼为正式记忆')
  }
  if (target.content.length > SINGLE_TIDY_CONTENT_LIMIT) {
    throw new MemoryError(400, `当前正文超过 ${SINGLE_TIDY_CONTENT_LIMIT} 字，暂不支持单次规范整理`)
  }

  const conn = await loadResolvedModel(db, masterKey, CHAT_LLM_SETTING_KEY)
  if (!conn) throw new MemoryError(400, '尚未配置或启用对话模型')

  options.onStage?.('preclean', '正在执行确定性结构预清洗…')
  if (options.signal?.aborted) throw new CaptureAbortedError()

  const activeTargets = await db
    .select({
      id: entries.id,
      shortId: entries.shortId,
      title: entries.title,
      realms: entries.realms,
      topics: entries.topics,
      projects: entries.projects,
    })
    .from(entries)
    .where(and(eq(entries.kind, 'entry'), isNull(entries.deletedAt)))
    .orderBy(asc(entries.shortId))

  const slugIndex = buildUniqueSlugIndex(activeTargets)
  const deterministic = computeDeterministicFixes(target, slugIndex)
  const preCleanedFixes: HygieneSweepFixKind[] = deterministic?.candidate.fixes ?? []
  const preCleanedContent = deterministic?.nextContent ?? target.content

  options.onStage?.('llm', '正在调用对话模型规范标题、现行概要与正文结构…')
  if (options.signal?.aborted) throw new CaptureAbortedError()

  const preCleanedRow = { ...target, content: preCleanedContent }
  const promptItem = toPromptItem(preCleanedRow, SINGLE_TIDY_CONTENT_LIMIT)
  const tidyMessages = buildTidyMessages(promptItem)
  const maxTokens = computeSingleTidyMaxTokens(promptItem.content.length)

  let rawContent: string
  try {
    const res = await chatComplete(conn, tidyMessages, {
      temperature: 0.1,
      jsonMode: true,
      maxTokens,
      timeoutMs: SINGLE_TIDY_TIMEOUT_MS,
      stream: true,
      taskKind: 'organize',
      maxRetries: 1,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    rawContent = res.content
  } catch (err) {
    if (isAbortError(err, options.signal)) throw new CaptureAbortedError()
    throw new MemoryError(
      502,
      `模型规范整理失败：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  options.onStage?.('verify', '正在校验双链与凭据引用完整性…')
  let evaluated = evaluateTidyResponse(rawContent, promptItem)
  if (evaluated.status === 'invalid') {
    if (options.signal?.aborted) throw new CaptureAbortedError()
    options.onStage?.('llm', '检测到格式或引用遗漏，正在进行一次定向修正…')
    try {
      const repairMessages = buildSemanticRepairMessages(
        tidyMessages,
        buildRepairFeedback(evaluated),
      )
      const repaired = await chatComplete(conn, repairMessages, {
        temperature: 0,
        jsonMode: true,
        maxTokens,
        timeoutMs: SINGLE_TIDY_TIMEOUT_MS,
        stream: true,
        taskKind: 'organize',
        maxRetries: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      options.onStage?.('verify', '正在复核修正后的完整性…')
      evaluated = evaluateTidyResponse(repaired.content, promptItem)
    } catch (err) {
      if (isAbortError(err, options.signal)) throw new CaptureAbortedError()
      throw new MemoryError(
        502,
        `模型规范整理修正失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  if (evaluated.status === 'invalid') {
    throw new MemoryError(422, evaluated.reason)
  }

  const hasPreCleanDiff = preCleanedContent !== target.content
  if (evaluated.status === 'not_needed') {
    const integrity = checkCaptureIntegrity(target.content, preCleanedContent)
    return {
      shortId: target.shortId,
      baseVersion: target.version,
      needed: hasPreCleanDiff,
      reason: hasPreCleanDiff
        ? '模型判定无需进一步改写，但确定性预清洗已修复重复标题、旧关键词行或旧路径引用。'
        : '当前记忆标题清晰、概要与正文结构良好，无需进一步规范。',
      preCleanedFixes,
      before: {
        title: target.title,
        summary: target.summary,
        content: target.content,
      },
      proposed: {
        title: target.title,
        summary: target.summary,
        content: preCleanedContent,
        changeSummary: hasPreCleanDiff ? '确定性结构预清洗' : '',
        archivedNotes: [],
      },
      integrity,
    }
  }

  const prop = evaluated.proposal
  const finalTitle = prop.proposedTitle ?? target.title
  const finalSummary = prop.proposedSummary ?? target.summary
  const finalContent = prop.proposedContent ?? preCleanedContent
  const integrity = checkCaptureIntegrity(target.content, finalContent)
  if (integrity.missingLinks.length > 0 || integrity.missingCreds.length > 0) {
    throw new MemoryError(
      422,
      `草案丢失原有引用（${[...integrity.missingLinks, ...integrity.missingCreds].join('、')}），已拦截`,
    )
  }

  const actuallyChanged =
    finalTitle !== target.title ||
    (finalSummary ?? null) !== (target.summary ?? null) ||
    finalContent !== target.content

  return {
    shortId: target.shortId,
    baseVersion: target.version,
    needed: actuallyChanged,
    reason: prop.reason,
    preCleanedFixes,
    before: {
      title: target.title,
      summary: target.summary,
      content: target.content,
    },
    proposed: {
      title: finalTitle,
      summary: finalSummary,
      content: finalContent,
      changeSummary: prop.proposedChangeSummary ?? '规范标题与正文结构，剥离历史流水账',
      archivedNotes: prop.archivedNotes ?? [],
    },
    integrity,
  }
}
