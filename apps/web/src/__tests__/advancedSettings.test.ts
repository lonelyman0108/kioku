import {
  PromptSupplement,
  TUNING_DEFAULTS,
  type DebugCandidate,
  type TuningKey,
  type TuningSources,
  type TuningValues,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h, nextTick, ref, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import {
  formatTuning,
  promptText,
  SUPPLEMENT_MAX,
  rangeOf,
  overriddenAt,
  overriddenIn,
  stepOf,
  trialRows,
  trialSettings,
  trialSummary,
} from '../advancedSettings'
import appAdvanced from '../components/AppAdvancedSettings.vue?raw'
import instancePrompts from '../components/InstancePromptSettings.vue?raw'
import promptSupplement from '../components/PromptSupplementEditor.vue?raw'
import SourceTag from '../components/SourceTag.vue'
import spaceAdvancedExtraction from '../components/SpaceAdvancedExtraction.vue?raw'
import spaceRecall from '../components/SpaceRecallSettings.vue?raw'
import { useSavedField, useSavedText } from '../composables/useSavedField'
import { useTuningFields } from '../composables/useTuningFields'

const candidate = (title: string, rawScore: number, priority = 2): DebugCandidate => ({
  uri: `core://${title}`,
  title,
  layer: 'core',
  priority,
  disclosure: null,
  score: Math.round(rawScore * 100) / 100,
  via: ['glossary'],
  cues: [],
  breakdown: { semantic: 0, fulltext: 0, glossary: rawScore, priority: 0 },
  rawScore,
})

describe('试算的本地重算', () => {
  it('过了最低分的前几条注入，排在后面的超出条数，其余不注入；按未取整的分数排序', () => {
    const rows = trialRows(
      [candidate('c', 0.21), candidate('a', 0.63), candidate('b', 0.3), candidate('d', 0.05)],
      0.2,
      2,
    )
    expect(rows.map((r) => [r.candidate.title, r.state])).toEqual([
      ['a', 'injected'],
      ['b', 'injected'],
      ['c', 'overLimit'],
      ['d', 'excluded'],
    ])
    expect(trialSummary(rows)).toBe('注入 2 条 · 不注入 2 条')
  })

  it('正好卡在阈值上的按未取整的分数判断，和服务端一致', () => {
    // 两条显示出来都是 0.25：一条差一点，一条正好
    const below = candidate('below', 0.2496)
    const exact = candidate('exact', 0.25)
    expect(below.score).toBe(0.25)
    const rows = trialRows([below, exact], 0.25, 8)
    expect(rows.map((r) => [r.candidate.title, r.state])).toEqual([
      ['exact', 'injected'],
      ['below', 'excluded'],
    ])
  })

  it('所选访问密钥的应用自己覆盖了最低分或条数：按应用的值试算，写明空间的设置对它不起作用', () => {
    const app = { id: 'a1', name: 'Codex' }
    const overrides = [
      {
        id: 'a1',
        name: 'Codex',
        overrides: { 'recall.minScore': 0.5, 'recall.limit': 3 },
        hasGuidance: false,
      },
    ]
    const used = trialSettings({ minScore: 0.2, limit: 8 }, app, overrides)
    expect(used).toEqual({
      minScore: 0.5,
      limit: 3,
      note: '应用「Codex」另有覆盖（最低分 0.50、条数 3），按它的值试算，空间的设置对它不起作用。',
    })
    const cands = Array.from({ length: 10 }, (_, i) => candidate(`c${i}`, 0.9 - i * 0.01))
    expect(trialSummary(trialRows(cands, used.minScore, used.limit))).toBe(
      '注入 3 条 · 不注入 7 条',
    )
    // 只覆盖了一项：另一项用空间表单的
    expect(
      trialSettings({ minScore: 0.2, limit: 8 }, app, [
        { id: 'a1', name: 'Codex', overrides: { 'recall.limit': 3 }, hasGuidance: true },
      ]),
    ).toMatchObject({ minScore: 0.2, limit: 3 })
    // 没有覆盖的应用：用空间表单的，不写说明
    expect(
      trialSettings({ minScore: 0.2, limit: 8 }, { id: 'a2', name: '别的' }, overrides),
    ).toEqual({
      minScore: 0.2,
      limit: 8,
      note: null,
    })
  })

  it('分数相同按优先级', () => {
    const rows = trialRows([candidate('later', 0.4, 3), candidate('first', 0.4, 0)], 0.2, 1)
    expect(rows.map((r) => [r.candidate.title, r.state])).toEqual([
      ['first', 'injected'],
      ['later', 'overLimit'],
    ])
  })
})

describe('补充的拼接', () => {
  it('固定部分在前，补充按级接在后面，每段另起一行；空的补充不接', () => {
    expect(promptText('固定', ['实例的', '  ', null, '应用的'])).toBe('固定\n实例的\n应用的')
    expect(promptText('固定', [])).toBe('固定')
  })

  it('字数按字符算，超出上限与控制字符拦下', async () => {
    const saved = ref<string | undefined>('原来的')
    // 合不合法以契约的 PromptSupplement 为准
    const text = useSavedText(() => saved.value, PromptSupplement, SUPPLEMENT_MAX)
    expect(text.changed.value).toBe(false)
    text.value.value = '😀'.repeat(2000)
    expect(text.length.value).toBe(2000)
    expect(text.invalid.value).toBe(false)
    text.value.value = '字'.repeat(2001)
    expect(text.issue.value).toBe('tooLong')
    text.value.value = 'a\ud800'
    expect(text.issue.value).toBe('control')
    text.value.value = 'a\u0007'
    expect(text.issue.value).toBe('control')
    text.value.value = '第一行\n\t第二行'.slice(0, 5)
    expect(text.invalid.value).toBe(false)
    // 没改时跟着服务端的新值，改过就留着
    text.reset()
    saved.value = '别处改的'
    await nextTick()
    expect(text.value.value).toBe('别处改的')
  })

  it('编辑器：固定部分只读在上，上一级的补充写明来自哪一级，有预览全文与恢复', () => {
    const { descriptor } = parse(promptSupplement)
    const tpl = descriptor.template!.content
    expect(tpl).toContain('固定部分')
    expect(tpl).toContain('来自{{ inherited.level }}')
    expect(tpl).toContain('预览全文')
    expect(tpl).toContain('@click="model = \'\'"')
    expect(tpl.indexOf('固定部分')).toBeLessThan(tpl.indexOf('的补充'))
  })
})

describe('来源与恢复', () => {
  it('这一级覆盖了哪几项以服务端为准', () => {
    const sources = Object.fromEntries(
      Object.keys(TUNING_DEFAULTS).map((k) => [k, 'instance']),
    ) as TuningSources
    sources['recall.limit'] = 'space'
    sources['recall.minScore'] = 'app'
    expect([...overriddenAt(sources, 'space')!]).toEqual(['recall.limit'])
    expect([...overriddenIn({ 'recall.limit': 3, 'prompts.agentGuidance': '补充' })!]).toEqual([
      'recall.limit',
    ])
    expect(overriddenAt(undefined, 'space')).toBeUndefined()
  })

  it('覆盖的值碰巧等于上一级：照样是已覆盖，恢复时显式写 null，之后上一级改了跟着走', async () => {
    const effective = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS })
    const instance = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS })
    const own = ref(new Set<TuningKey>(['recall.limit']))
    const t = useTuningFields(
      ['recall.limit', 'recall.minScore'] as const,
      () => effective.value,
      () => instance.value,
      () => own.value,
    )
    expect(t.sourceOf('recall.limit')).toBe('overridden')
    expect(t.changedKeys.value).toEqual([])
    t.restore('recall.limit')
    expect(t.sourceOf('recall.limit')).toBe('inherited')
    expect(t.changedKeys.value).toEqual(['recall.limit'])
    expect(t.patch()).toEqual({ 'recall.limit': null })
    // 恢复之后又改了值：又是覆盖
    t.fields['recall.limit'].value.value = 5
    expect(t.sourceOf('recall.limit')).toBe('overridden')
    expect(t.patch()).toEqual({ 'recall.limit': 5 })
    // 放弃：回到服务端的样子
    t.reset()
    expect(t.sourceOf('recall.limit')).toBe('overridden')
    expect(t.patch()).toEqual({})
    // 改回原来的值不算改动；改成别的值是覆盖
    t.fields['recall.minScore'].value.value = 0.3
    t.fields['recall.minScore'].value.value = 0.2
    expect(t.sourceOf('recall.minScore')).toBe('inherited')
    t.fields['recall.minScore'].value.value = 0.25
    expect(t.patch()).toEqual({ 'recall.minScore': 0.25 })
  })

  it('一级的几项：基准是生效值，恢复回到上一级的值，保存后跟着服务端返回的值', async () => {
    const effective = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS, 'recall.limit': 3 })
    const instance = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS })
    const own = ref(new Set<TuningKey>(['recall.limit']))
    const t = useTuningFields(
      ['recall.limit', 'recall.minScore'] as const,
      () => effective.value,
      () => instance.value,
      () => own.value,
    )
    expect(t.sourceOf('recall.limit')).toBe('overridden')
    expect(t.sourceOf('recall.minScore')).toBe('inherited')
    t.restore('recall.limit')
    expect(t.fields['recall.limit'].value.value).toBe(8)
    expect(t.changedKeys.value).toEqual(['recall.limit'])
    expect(t.patch()).toEqual({ 'recall.limit': null })
    t.fields['recall.minScore'].value.value = 0.255
    expect(t.problem.value).toBe('最低分：最多两位小数')
    t.fields['recall.minScore'].value.value = 0.3
    const submitted = t.snapshot()
    t.commit(submitted, { ...TUNING_DEFAULTS, 'recall.minScore': 0.3 })
    // 服务端返回的来源：这一级只覆盖了最低分
    own.value = new Set(['recall.minScore'])
    expect(t.changedKeys.value).toEqual([])
    expect(t.sourceOf('recall.minScore')).toBe('overridden')
    // 实例的值变了、本级没覆盖的项跟上
    effective.value = { ...TUNING_DEFAULTS, 'recall.minScore': 0.3, 'recall.limit': 6 }
    instance.value = { ...TUNING_DEFAULTS, 'recall.limit': 6 }
    await nextTick()
    expect(t.fields['recall.limit'].value.value).toBe(6)
    expect(t.sourceOf('recall.limit')).toBe('inherited')
  })

  it('小数的项收两位小数，整数的项不收小数；范围取自契约', () => {
    expect(rangeOf('recall.minScore')).toMatchObject({ min: 0, max: 1, decimals: true })
    expect(rangeOf('boot.charBudget')).toMatchObject({ min: 2000, max: 40000, decimals: false })
    expect(rangeOf('boot.summaries.enabled')).toEqual({ min: 0, max: 1 })
    expect([stepOf('recall.minScore'), stepOf('boot.charBudget'), stepOf('recall.limit')]).toEqual([
      0.01, 1000, 1,
    ])
    // 两位小数的判断就是契约的那一份
    const score = useSavedField(() => 0.2, rangeOf('recall.minScore'))
    score.value.value = 0.29
    expect(score.issue.value).toBeNull()
    score.value.value = 0.255
    expect(score.issue.value).toBe('precision')
    const f = useSavedField(() => 8, rangeOf('recall.limit'))
    f.value.value = 2.5
    expect(f.issue.value).toBe('fraction')
    f.value.value = 21
    expect(f.issue.value).toBe('range')
    expect(formatTuning('recall.minScore', 0.2)).toBe('0.20')
    expect(formatTuning('boot.charBudget', 16000)).toBe('16,000')
    expect(formatTuning('boot.recent.enabled', false)).toBe('关')
  })

  it('来源标签：沿用是「沿用实例 · 值」，覆盖是「已覆盖」，能改时才给「恢复为实例的 值」', async () => {
    const render = (props: Record<string, unknown>) =>
      renderToString(createSSRApp({ render: () => h(SourceTag as Component, props) }))
    const inherited = await render({ source: 'inherited', level: '实例', value: '8' })
    expect(inherited.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ')).toContain('沿用实例 · 8')
    const editable = await render({
      source: 'overridden',
      level: '实例',
      value: '0.20',
      editable: true,
    })
    expect(editable).toContain('已覆盖')
    expect(editable.replace(/\s+/g, ' ')).toContain('恢复为实例的 0.20')
    const readonly = await render({ source: 'overridden', level: '空间', value: '8' })
    expect(readonly).toContain('已覆盖')
    expect(readonly).not.toContain('恢复为')
    expect(readonly.replace(/\s+/g, ' ')).toContain('空间为 8')
  })
})

describe('只读', () => {
  it('不能改时控件禁用、不显示保存条，写明谁能改', () => {
    for (const [source, who] of [
      [spaceRecall, '仅空间所有者可修改。'],
      [spaceAdvancedExtraction, '仅空间所有者可修改。'],
      [appAdvanced, '仅应用所有者可修改。'],
    ] as const) {
      const tpl = parse(source).descriptor.template!.content
      expect(tpl).toMatch(/<SaveBar\s+v-if="editable"/)
      expect(tpl).toContain(`<p v-if="!editable" class="pt-`)
      expect(tpl).toContain(who)
      expect(tpl).toContain(':editable="editable"')
    }
    // 实例的这一节只给实例管理员，没有只读的状态
    expect(parse(instancePrompts).descriptor.template!.content).toContain('<SaveBar')
  })

  it('保存条在表单里：回车保存', () => {
    for (const source of [spaceRecall, spaceAdvancedExtraction, appAdvanced, instancePrompts]) {
      const tpl = parse(source).descriptor.template!.content
      expect(tpl).toContain('<form v-')
      expect(tpl).toContain('@submit.prevent="save"')
      expect(tpl.indexOf('<SaveBar')).toBeGreaterThan(tpl.indexOf('<form'))
    }
  })
})
