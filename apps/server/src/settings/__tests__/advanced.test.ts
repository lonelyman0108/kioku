import {
  TUNING_DEFAULTS,
  TUNING_KEYS,
  UpdateAppAdvanced,
  UpdateInstanceAdvanced,
  UpdateSpaceAdvanced,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  effectiveSettings,
  parseInstanceAdvanced,
  resolveTuning,
  splitPatch,
  withSupplements,
} from '../advanced'

describe('高级设置的取值', () => {
  it('各级都没有覆盖时是内置值，来源都是内置', () => {
    const { values, sources } = resolveTuning({})
    expect(values).toEqual(TUNING_DEFAULTS)
    expect(new Set(Object.values(sources))).toEqual(new Set(['builtin']))
    expect(Object.keys(sources).sort()).toEqual([...TUNING_KEYS].sort())
  })

  it('按「内置 → 实例 → 空间 → 应用」逐项覆盖，每一项记下来源', () => {
    const { values, sources } = resolveTuning({
      instance: { 'recall.minScore': 0.3, 'recall.limit': 6, 'recallWeights.semantic': 0.5 },
      space: { 'recall.minScore': 0.25, 'extraction.batchTurns': 4 },
      app: { 'recall.minScore': 0.4, 'boot.recent.enabled': false },
    })
    expect(values).toMatchObject({
      'recall.minScore': 0.4,
      'recall.limit': 6,
      'recallWeights.semantic': 0.5,
      'extraction.batchTurns': 4,
      'boot.recent.enabled': false,
      'boot.charBudget': TUNING_DEFAULTS['boot.charBudget'],
    })
    expect(sources).toMatchObject({
      'recall.minScore': 'app',
      'recall.limit': 'instance',
      'recallWeights.semantic': 'instance',
      'extraction.batchTurns': 'space',
      'boot.recent.enabled': 'app',
      'boot.charBudget': 'builtin',
    })
  })

  it('覆盖成 false 与 0 也算覆盖', () => {
    const { values, sources } = resolveTuning({
      space: { 'boot.summaries.enabled': false, 'recall.subjectFacts': 0 },
    })
    expect(values['boot.summaries.enabled']).toBe(false)
    expect(values['recall.subjectFacts']).toBe(0)
    expect(sources['recall.subjectFacts']).toBe('space')
  })

  it('补充按级叠加：实例的在前，空间或应用的在后；应用的使用指引只接在它实际用的那一种后面', () => {
    const layers = {
      instance: {
        'prompts.agentGuidance': '实例：编码',
        'prompts.chatGuidance': '实例：群聊',
        'prompts.extractionRules': '实例：抽取',
      },
      space: { 'prompts.extractionRules': '空间：抽取', 'prompts.dreamRules': '空间：整理' },
      app: { 'prompts.guidance': '应用的指引' },
    }
    expect(effectiveSettings(layers).prompts).toEqual({
      agentGuidance: ['实例：编码', '应用的指引'],
      chatGuidance: ['实例：群聊'],
      extractionRules: ['实例：抽取', '空间：抽取'],
      dreamRules: ['空间：整理'],
    })
    expect(effectiveSettings(layers, true).prompts).toMatchObject({
      agentGuidance: ['实例：编码'],
      chatGuidance: ['实例：群聊', '应用的指引'],
    })
    expect(withSupplements('固定', ['甲', '乙'])).toBe('固定\n甲\n乙')
    expect(withSupplements('固定', [])).toBe('固定')
  })

  it('存下的覆盖逐项检查：不成立的项当作没有覆盖', () => {
    expect(
      parseInstanceAdvanced({
        'recall.limit': 99,
        'recall.minScore': 0.3,
        'boot.recent.enabled': 'yes',
        unknown: 1,
      }),
    ).toEqual({ 'recall.minScore': 0.3 })
    expect(parseInstanceAdvanced(null)).toEqual({})
    expect(parseInstanceAdvanced([1])).toEqual({})
  })

  it('修改：null 与只有空白的补充是恢复，其余照写', () => {
    expect(
      splitPatch({
        'recall.limit': 5,
        'recall.minScore': null,
        'prompts.agentGuidance': '  \n',
        'prompts.chatGuidance': '只回中文',
        'boot.recent.enabled': false,
        'boot.charBudget': undefined,
      }),
    ).toEqual({
      set: { 'recall.limit': 5, 'prompts.chatGuidance': '只回中文', 'boot.recent.enabled': false },
      remove: ['recall.minScore', 'prompts.agentGuidance'],
    })
  })
})

describe('高级设置的校验', () => {
  const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
    schema.safeParse(value).success

  it('数值的上下限', () => {
    const cases: [string, unknown, boolean][] = [
      ['recall.limit', 1, true],
      ['recall.limit', 20, true],
      ['recall.limit', 0, false],
      ['recall.limit', 21, false],
      ['recall.limit', 2.5, false],
      ['recall.minScore', 0, true],
      ['recall.minScore', 1, true],
      ['recall.minScore', 0.29, true],
      ['recall.minScore', 0.255, false],
      ['recall.minScore', 1.01, false],
      ['recall.subjectFacts', 0, true],
      ['recall.subjectFacts', 21, false],
      ['recall.chatInlineChars', 49, false],
      ['recall.chatInlineChars', 1000, true],
      ['recallWeights.priority', 0.06, true],
      ['recallWeights.priority', -0.01, false],
      ['boot.charBudget', 1999, false],
      ['boot.charBudget', 40000, true],
      ['boot.charBudget', 40001, false],
      ['boot.summaries.count', 20, true],
      ['boot.summaries.count', 21, false],
      ['boot.recent.enabled', 'true', false],
      ['extraction.batchTurns', 0, false],
      ['extraction.batchTurns', 50, true],
      ['extraction.idleMinutes', 121, false],
      ['extraction.episodeTtlDays', 365, true],
      ['extraction.episodeTtlDays', 366, false],
      ['dream.maxCalls', 2, false],
      ['dream.maxCalls', 3, true],
      ['dream.maxCalls', 31, false],
      ['dream.maxSuggestions', 0, false],
      ['dream.maxSuggestions', 50, true],
    ]
    for (const [key, value, expected] of cases) {
      expect(ok(UpdateInstanceAdvanced, { [key]: value }), `${key}=${String(value)}`).toBe(expected)
    }
    expect(ok(UpdateInstanceAdvanced, { 'recall.limit': null })).toBe(true)
  })

  it('各级只收能覆盖的项，不认识的键拒收', () => {
    expect(ok(UpdateSpaceAdvanced, { 'recallWeights.semantic': 0.5 })).toBe(false)
    expect(ok(UpdateSpaceAdvanced, { 'prompts.agentGuidance': '补充' })).toBe(false)
    expect(ok(UpdateSpaceAdvanced, { 'dream.maxCalls': 5, 'prompts.dreamRules': '补充' })).toBe(
      true,
    )
    expect(ok(UpdateAppAdvanced, { 'extraction.batchTurns': 5 })).toBe(false)
    expect(ok(UpdateAppAdvanced, { 'dream.maxCalls': 5 })).toBe(false)
    expect(ok(UpdateAppAdvanced, { 'prompts.extractionRules': '补充' })).toBe(false)
    expect(ok(UpdateAppAdvanced, { 'boot.charBudget': 3000, 'prompts.guidance': '补充' })).toBe(
      true,
    )
    expect(ok(UpdateInstanceAdvanced, { 'recall.unknown': 1 })).toBe(false)
  })

  it('补充至多 2,000 字（按字符数），只收换行与制表符以外的可见字符', () => {
    const key = 'prompts.agentGuidance'
    expect(ok(UpdateInstanceAdvanced, { [key]: '字'.repeat(2000) })).toBe(true)
    expect(ok(UpdateInstanceAdvanced, { [key]: '😀'.repeat(2000) })).toBe(true)
    expect(ok(UpdateInstanceAdvanced, { [key]: '字'.repeat(2001) })).toBe(false)
    expect(ok(UpdateInstanceAdvanced, { [key]: '第一行\n\t第二行' })).toBe(true)
    for (const bad of ['a\u0000b', 'a\rb', 'a\u001bb', 'a\u007fb', 'a\ud800b']) {
      expect(ok(UpdateInstanceAdvanced, { [key]: bad }), JSON.stringify(bad)).toBe(false)
    }
  })
})
