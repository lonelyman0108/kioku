import {
  CHANGE_SUMMARY_MAX,
  ENTRY_TITLE_RECOMMENDED_MAX,
  isTitleDirty,
  lintEntryHygiene,
  splitTitleLogSuffix,
  type HygieneWarning,
} from '@kioku/contracts'

export interface TitleHintResult {
  dirty: boolean
  warnings: HygieneWarning[]
  message: string | null
  splittable: { cleanTitle: string; extractedNote: string } | null
}

// 标题非阻断轻提示：检测超长标题或夹带日期、更新日志后缀，并提供可拆出的干净短标题
export function analyzeTitleHint(
  title: string,
  content = '',
  mode: 'edit' | 'create' = 'edit',
): TitleHintResult {
  const trimmed = title.trim()
  if (!trimmed) {
    return { dirty: false, warnings: [], message: null, splittable: null }
  }

  const warnings = lintEntryHygiene({ title: trimmed, content }).filter(
    (w) => w.code === 'title_too_long' || w.code === 'title_has_date_or_log',
  )
  const dirty = isTitleDirty(trimmed)
  const splittable = splitTitleLogSuffix(trimmed)

  let message: string | null = null
  if (warnings.length > 0) {
    const hasLog = warnings.some((w) => w.code === 'title_has_date_or_log')
    const hasLong = warnings.some((w) => w.code === 'title_too_long')
    if (mode === 'create') {
      if (hasLog && hasLong) {
        message = `标题共 ${trimmed.length} 字且含日期或状态说明，建议控制在 ${ENTRY_TITLE_RECOMMENDED_MAX} 字内，保持简短稳定`
      } else if (hasLog) {
        message = '标题包含日期或状态说明，建议保持稳定主题名，正文或后续变更再记录演进'
      } else {
        message = warnings[0]!.message
      }
    } else if (hasLog && hasLong) {
      message = `标题共 ${trimmed.length} 字且含日期或变更说明，建议控制在 ${ENTRY_TITLE_RECOMMENDED_MAX} 字内，将变动记录写入变更说明`
    } else {
      message = warnings[0]!.message
    }
  }

  return { dirty, warnings, message, splittable }
}

// 将拆出的标题后缀合并进已有变更说明，避免重复拼接并严格控制在长度上限内
export function appendExtractedChangeNote(existing: string, extractedNote: string): string {
  const cleanExisting = existing.trim()
  const cleanNote = extractedNote.trim()
  if (!cleanNote) return cleanExisting.slice(0, CHANGE_SUMMARY_MAX)
  if (!cleanExisting) return cleanNote.slice(0, CHANGE_SUMMARY_MAX)
  if (cleanExisting.includes(cleanNote)) return cleanExisting.slice(0, CHANGE_SUMMARY_MAX)
  return `${cleanExisting}；${cleanNote}`.slice(0, CHANGE_SUMMARY_MAX)
}
