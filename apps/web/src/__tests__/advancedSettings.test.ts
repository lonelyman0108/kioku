import { TUNING_DEFAULTS, type DebugCandidate, type TuningValues } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h, nextTick, ref, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import {
  buildPatch,
  formatTuning,
  promptText,
  rangeOf,
  rowSource,
  trialRows,
  trialSummary,
} from '../advancedSettings'
import appAdvanced from '../components/AppAdvancedSettings.vue?raw'
import instancePrompts from '../components/InstancePromptSettings.vue?raw'
import promptSupplement from '../components/PromptSupplement.vue?raw'
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
    const text = useSavedText(() => saved.value, 5)
    expect(text.changed.value).toBe(false)
    text.value.value = '😀😀😀😀😀'
    expect(text.length.value).toBe(5)
    expect(text.invalid.value).toBe(false)
    text.value.value = '六个字六个字'
    expect(text.issue.value).toBe('tooLong')
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
  it('和上一级一样是沿用，不一样是已覆盖', () => {
    expect(rowSource('recall.limit', 8, 8)).toBe('inherited')
    expect(rowSource('recall.limit', 6, 8)).toBe('overridden')
    expect(rowSource('boot.recent.enabled', 0, true)).toBe('overridden')
    expect(rowSource('boot.recent.enabled', 1, true)).toBe('inherited')
  })

  it('修改请求：改回上一级的值写 null，开关写回布尔', () => {
    const inherited = { ...TUNING_DEFAULTS }
    expect(
      buildPatch(
        [
          { key: 'recall.limit', changed: true, value: 8 },
          { key: 'recall.minScore', changed: true, value: 0.25 },
          { key: 'boot.recent.enabled', changed: true, value: 0 },
          { key: 'boot.charBudget', changed: false, value: 3000 },
          { key: 'recall.subjectFacts', changed: true, value: null },
        ],
        inherited,
      ),
    ).toEqual({ 'recall.limit': null, 'recall.minScore': 0.25, 'boot.recent.enabled': false })
  })

  it('一级的几项：基准是生效值，恢复回到上一级的值，保存后跟着服务端返回的值', async () => {
    const effective = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS, 'recall.limit': 3 })
    const instance = ref<TuningValues | undefined>({ ...TUNING_DEFAULTS })
    const t = useTuningFields(
      ['recall.limit', 'recall.minScore'] as const,
      () => effective.value,
      () => instance.value,
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
    expect(rangeOf('recall.minScore')).toEqual({ min: 0, max: 1, decimals: 2 })
    expect(rangeOf('boot.charBudget')).toEqual({ min: 2000, max: 40000 })
    expect(rangeOf('boot.summaries.enabled')).toEqual({ min: 0, max: 1 })
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
