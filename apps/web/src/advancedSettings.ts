import {
  PROMPT_SUPPLEMENT_MAX_CHARS,
  TuningValues,
  type DebugCandidate,
  type SettingSource,
  type TuningKey,
} from '@kioku/contracts'
import type { QueryClient } from '@tanstack/vue-query'

// 高级设置的界面：各项的名称与单位、取值范围、来源的说法、试算的本地重算与补充的拼接。
// 取值顺序是「实例默认 → 空间 → 应用」，每一级只存覆盖了的项；补充只叠加，固定部分在前

export const SUPPLEMENT_MAX = PROMPT_SUPPLEMENT_MAX_CHARS

export interface TuningMeta {
  label: string
  description?: string
  unit?: string
}

export const TUNING_META: Record<TuningKey, TuningMeta> = {
  'recall.limit': { label: '注入条数', description: '过了最低分之后最多注入几条', unit: '条' },
  'recall.minScore': {
    label: '最低分',
    description: '向量、全文、关键词加权后的分数，低于它的不注入',
  },
  'recall.subjectFacts': {
    label: '联系人事实条数',
    description: '群聊与私聊时附上发言人、本群的事实',
    unit: '条',
  },
  'recall.chatInlineChars': {
    label: '群聊召回附带正文',
    description: '群聊机器人无法读取坐标，召回时直接附正文开头',
    unit: '字',
  },
  'recallWeights.semantic': { label: '向量相似度', description: '未配置嵌入模型时这一路不参与' },
  'recallWeights.fulltext': { label: '全文检索', description: 'BM25' },
  'recallWeights.glossaryFirst': { label: '关键词（首个）', description: '命中第一个关键词' },
  'recallWeights.glossaryMore': { label: '关键词（其余）', description: '每多命中一个' },
  'recallWeights.priority': { label: '优先级', description: '优先级数字越小加分越多' },
  'boot.charBudget': {
    label: '字数预算',
    description: '超出的记忆只列标题，模型需要时再读',
    unit: '字',
  },
  'boot.summaries.enabled': { label: '同一会话的会话摘要' },
  'boot.summaries.count': { label: '会话摘要条数', unit: '条' },
  'boot.recent.enabled': { label: '近期更新的记忆' },
  'boot.recent.count': { label: '近期更新条数', unit: '条' },
  'boot.related.enabled': { label: '与当前项目相关' },
  'boot.related.count': { label: '项目相关条数', unit: '条' },
  'extraction.batchTurns': {
    label: '每批轮数',
    description: '攒满这么多轮马上抽取',
    unit: '轮',
  },
  'extraction.idleMinutes': {
    label: '空闲多久开始',
    description: '不满一批时，最后一轮之后等这么久再抽取',
    unit: '分钟',
  },
  'extraction.episodeTtlDays': {
    label: '会话摘要有效期',
    description: '到期后不再召回',
    unit: '天',
  },
  'dream.maxCalls': {
    label: '每次最多请求模型',
    description: '其中 2 次固定留给本人的记忆',
    unit: '次',
  },
  'dream.maxSuggestions': { label: '每次最多建议', description: '每次请求最多收几条', unit: '条' },
}

// 启动加载的三块附带内容，表格里一行一块
export const BOOT_EXTRAS = [
  { key: 'summaries', scope: '不带会话上下文的会话' },
  { key: 'recent', scope: '编码 Agent' },
  { key: 'related', scope: '带目录名或仓库名时' },
] as const
export type BootExtra = (typeof BOOT_EXTRAS)[number]['key']

// 两位小数的项：最低分与权重
const DECIMAL_KEYS = new Set<TuningKey>([
  'recall.minScore',
  'recallWeights.semantic',
  'recallWeights.fulltext',
  'recallWeights.glossaryFirst',
  'recallWeights.glossaryMore',
  'recallWeights.priority',
])
export const isDecimal = (key: TuningKey) => DECIMAL_KEYS.has(key)
export const isFlag = (key: TuningKey) => key.endsWith('.enabled')

// 取值范围取自契约，和服务端的校验是同一份；开关按 0、1 记
export function rangeOf(key: TuningKey): { min: number; max: number; decimals?: number } {
  if (isFlag(key)) return { min: 0, max: 1 }
  const schema = TuningValues.shape[key] as { minValue: number | null; maxValue: number | null }
  return {
    min: schema.minValue ?? 0,
    max: schema.maxValue ?? Number.MAX_SAFE_INTEGER,
    ...(isDecimal(key) ? { decimals: 2 } : {}),
  }
}

// 表单里的值：开关按 0、1 记
export const toFieldValue = (value: number | boolean): number =>
  typeof value === 'boolean' ? Number(value) : value
export const fromFieldValue = (key: TuningKey, value: number): number | boolean =>
  isFlag(key) ? value === 1 : value

export function formatTuning(key: TuningKey, value: number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (isDecimal(key)) return value.toFixed(2)
  return value.toLocaleString('en-US')
}

// 「沿用实例 · 8」里的那一级
export const LEVEL_NAMES: Record<SettingSource, string> = {
  builtin: '内置',
  instance: '实例',
  space: '空间',
  app: '应用',
}

// 一行的来源：表单里的值和上一级一样时是沿用，否则是本级覆盖
export function rowSource(
  key: TuningKey,
  value: number | null | undefined,
  inherited: number | boolean,
): 'inherited' | 'overridden' {
  return value === toFieldValue(inherited) || value === null || value === undefined
    ? 'inherited'
    : 'overridden'
}

// 修改请求：改过的项里，和上一级一样的写 null（恢复成沿用），其余写值
export function buildPatch(
  fields: readonly { key: TuningKey; changed: boolean; value: number | null | undefined }[],
  inherited: TuningValues,
): Record<string, number | boolean | null> {
  const patch: Record<string, number | boolean | null> = {}
  for (const f of fields) {
    if (!f.changed || typeof f.value !== 'number') continue
    patch[f.key] =
      f.value === toFieldValue(inherited[f.key]) ? null : fromFieldValue(f.key, f.value)
  }
  return patch
}

// 客户端名，宿主上限的表格用
const RUNTIME_NAMES: Record<string, string> = { claudecode: 'Claude Code', codex: 'Codex' }
export const runtimeName = (family: string) => RUNTIME_NAMES[family] ?? family

// 试算：拿召回调试的候选，按表单里的最低分与条数在本地重算。和服务端一样：按未取整的分数排序、和最低分比，
// 过了最低分的取前 limit 条注入，过了但排在后面的是超出条数，其余不注入
export type TrialState = 'injected' | 'overLimit' | 'excluded'
export interface TrialRow {
  candidate: DebugCandidate
  state: TrialState
}
export const TRIAL_STATE_NAMES: Record<TrialState, string> = {
  injected: '注入',
  overLimit: '超出条数',
  excluded: '不注入',
}

export function trialRows(
  candidates: readonly DebugCandidate[],
  minScore: number,
  limit: number,
): TrialRow[] {
  const sorted = [...candidates].sort((a, b) => b.rawScore - a.rawScore || a.priority - b.priority)
  let passed = 0
  return sorted.map((candidate) => {
    if (candidate.rawScore < minScore) return { candidate, state: 'excluded' }
    passed++
    return { candidate, state: passed <= limit ? 'injected' : 'overLimit' }
  })
}

export function trialSummary(rows: readonly TrialRow[]): string {
  const injected = rows.filter((r) => r.state === 'injected').length
  return `注入 ${injected} 条 · 不注入 ${rows.length - injected} 条`
}

// 预览全文：固定部分在前，补充按级接在后面，和服务端拼给模型的一样（每段另起一行，空的补充不接）
export function promptText(fixed: string, supplements: readonly (string | null | undefined)[]) {
  return [fixed, ...supplements.filter((s): s is string => !!s && s.trim() !== '')].join('\n')
}

// 查询键：三级的视图互相依赖（实例改了，空间与应用的沿用值跟着变），保存后整组失效
export const ADVANCED_KEY = ['advanced-settings'] as const
export const instanceAdvancedKey = () => [...ADVANCED_KEY, 'instance'] as const
export const spaceAdvancedKey = (spaceId: string) => [...ADVANCED_KEY, 'space', spaceId] as const
export const appAdvancedKey = (spaceId: string, appId: string) =>
  [...ADVANCED_KEY, 'app', spaceId, appId] as const
export const refreshAdvanced = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: ADVANCED_KEY })
