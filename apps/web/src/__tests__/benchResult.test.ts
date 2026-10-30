import type { BenchChanges, BenchStepResult } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  changeItems,
  changesNotListed,
  errorNote,
  internalErrorText,
  sessionNotes,
  stepBadge,
  turnNotBuffered,
} from '../benchResult'

const step = (over: Partial<BenchStepResult> = {}): BenchStepResult => ({
  index: 0,
  label: 'kioku_get',
  kind: 'tool',
  status: 'passed',
  reason: null,
  isError: false,
  internalError: false,
  internalDetail: null,
  httpStatus: null,
  text: '',
  raw: {},
  ms: 1,
  uris: [],
  session: null,
  vectorSkipped: false,
  assertions: [],
  captured: {},
  changes: null,
  replay: null,
  ...over,
})

const noChanges: BenchChanges = {
  memories: [],
  hiddenReleased: 0,
  hiddenOther: 0,
  credentials: [],
  subjects: 0,
  identities: [],
  turns: 0,
  turn: null,
}

describe('一步的状态', () => {
  it('场景按断言：四种状态分开显示', () => {
    const labels = (['passed', 'failed', 'skipped', 'notRun'] as const).map((status) => {
      const badge = stepBadge(step({ status }), 'judged')
      return [badge.label, badge.color]
    })
    expect(labels).toEqual([
      ['通过', 'success'],
      ['失败', 'error'],
      ['跳过', 'neutral'],
      ['没有执行', 'warning'],
    ])
  })

  it('调用台没有断言：报错的工具不能显示成通过', () => {
    // 服务端对没带断言的步骤一律算 passed
    expect(stepBadge(step({ isError: true }), 'call')).toMatchObject({
      label: '报错',
      color: 'error',
    })
    expect(stepBadge(step(), 'call')).toMatchObject({ label: '成功', color: 'success' })
    expect(stepBadge(step({ status: 'failed', internalError: true, isError: true }), 'call'))
      // 内部错误不和普通的报错混在一起
      .toMatchObject({ label: '内部错误', color: 'error' })
  })

  it('权限探测只列结果：不显示成通过或失败，也不用红绿', () => {
    const quiet = stepBadge(step(), 'probe')
    expect(quiet.label).toBe('有结果')
    expect(quiet.color).toBe('neutral')
    expect(stepBadge(step({ isError: true }), 'probe')).toMatchObject({
      label: '报错',
      color: 'neutral',
    })
    expect(stepBadge(step({ status: 'failed', isError: true }), 'probe').label).toBe('报错')
    // 内部错误不是这把 Key 的权限结果，照样标出来
    expect(stepBadge(step({ status: 'failed', internalError: true }), 'probe')).toMatchObject({
      label: '内部错误',
      color: 'error',
    })
  })

  it('跳过、没有执行、还没发出去就失败的，在哪种看法下都不算有结果', () => {
    for (const view of ['call', 'probe'] as const) {
      expect(stepBadge(step({ status: 'skipped', raw: null }), view).label).toBe('跳过')
      expect(stepBadge(step({ status: 'notRun', raw: null }), view).label).toBe('没有执行')
      expect(stepBadge(step({ status: 'failed', raw: null }), view).label).toBe('没有执行')
    }
  })

  it('内部错误的具体原因', () => {
    expect(internalErrorText(step({ internalDetail: 'lock_timeout' }))).toContain('等锁超时')
    expect(internalErrorText(step({ internalDetail: 'statement_timeout' }))).toContain('语句超时')
    expect(internalErrorText(step({ internalDetail: 'run_timeout' }))).toContain('总时长')
    expect(internalErrorText(step({ internalDetail: 'aborted' }))).toContain('根事务')
    expect(internalErrorText(step())).toContain('日志')
  })

  it('报错的说法：没报错、内部错误都不说；调用台用红字，权限探测不用', () => {
    expect(errorNote(step(), 'call')).toBeNull()
    expect(errorNote(step({ isError: true, internalError: true }), 'call')).toBeNull()
    expect(errorNote(step({ isError: true }), 'call')?.alarming).toBe(true)
    expect(errorNote(step({ isError: true }), 'probe')?.alarming).toBe(false)
  })

  it('报错的说法：场景里通过的步骤是预期之中或者没带断言，不用红字', () => {
    const asserted = errorNote(
      step({ isError: true, assertions: [{ message: '应当报错', ok: true }] }),
      'judged',
    )
    expect(asserted).toEqual({ text: '这一步报错了，符合断言。', alarming: false })
    const unasserted = errorNote(step({ isError: true }), 'judged')
    expect(unasserted?.text).toContain('没带断言')
    expect(unasserted?.alarming).toBe(false)
    expect(errorNote(step({ isError: true, status: 'failed' }), 'judged')?.alarming).toBe(true)
  })

  it('turn.end 没写进缓冲时要说：它不报错，看不到原因', () => {
    const turn = {
      kind: 'lifecycle',
      body: { event: 'turn.end' },
    } as unknown as BenchStepResult['replay']
    expect(turnNotBuffered(step({ replay: turn, changes: noChanges }))).toBe(true)
    expect(turnNotBuffered(step({ replay: turn, changes: { ...noChanges, turns: 1 } }))).toBe(false)
    // 真实模式下不列，不能说成没写进去
    expect(turnNotBuffered(step({ replay: turn, changes: { ...noChanges, turns: null } }))).toBe(
      false,
    )
    expect(turnNotBuffered(step({ changes: noChanges }))).toBe(false)
    expect(turnNotBuffered(step({ replay: turn, changes: null }))).toBe(false)
  })
})

describe('session.start 多带的三项', () => {
  it('字数上限、没展开的节点与放不下的附加块', () => {
    const notes = sessionNotes(
      { limit: 10, omitted: ['core://a'], dropped: ['recent', 'related'] },
      '一二三',
    )
    expect(notes).toEqual({
      size: '共 3 字，宿主能完整接收 10 字',
      overLimit: false,
      omitted: ['core://a'],
      dropped: ['近期更新的记忆', '与当前项目相关的记忆'],
    })
  })

  it('没有上限的宿主，与超出上限的情况', () => {
    expect(sessionNotes({ limit: null, omitted: [], dropped: [] }, 'x').size).toContain('没有字数')
    expect(sessionNotes({ limit: null, omitted: [], dropped: [] }, 'x').overLimit).toBe(false)
    expect(sessionNotes({ limit: 1, omitted: [], dropped: [] }, 'xy').overLimit).toBe(true)
  })
})

describe('这一步改了什么', () => {
  it('没有改动时什么都不列', () => {
    expect(changeItems(noChanges)).toEqual([])
    expect(changesNotListed(noChanges)).toBe(false)
  })

  it('记忆：动作、URI 与字段的中文名', () => {
    const [item] = changeItems({
      ...noChanges,
      memories: [
        {
          type: 'update',
          uri: 'core://a',
          fields: ['content', 'validTo', 'odd'],
          left: false,
          becameSecret: false,
        },
      ],
    })
    expect(item).toEqual({
      action: '修改',
      target: 'core://a',
      fields: ['正文', '有效期', 'odd'],
      warnings: [],
      notes: [],
    })
  })

  it('改成 secret 时提示历史正文会被抹掉、向量会删', () => {
    const [item] = changeItems({
      ...noChanges,
      memories: [{ type: 'update', uri: 'core://a', fields: [], left: false, becameSecret: true }],
    })
    expect(item!.warnings.join('')).toContain('历史里的正文会被抹掉')
    expect(item!.warnings.join('')).toContain('向量会删')
  })

  it('改后看不到了：说明 URI 是改前的', () => {
    const [item] = changeItems({
      ...noChanges,
      memories: [{ type: 'update', uri: 'core://a', fields: [], left: true, becameSecret: false }],
    })
    expect(item!.notes.join('')).toContain('改前的 URI')
  })

  it('看不到的改动只给个数', () => {
    const items = changeItems({ ...noChanges, hiddenReleased: 2, hiddenOther: 3 })
    expect(items.map((i) => i.action)).toEqual([
      '让出了 2 条看不到的过期记录（别的成员的）',
      '另外有 3 处改动看不到（这把 Key 能写却读不到的层）',
    ])
  })

  it('凭据：取用的字段与修改的部分', () => {
    const items = changeItems({
      ...noChanges,
      credentials: [
        { type: 'access', identifier: 'nas', fields: ['password'], changes: [] },
        { type: 'update', identifier: 'nas', fields: [], changes: ['description', 'odd'] },
        { type: 'odd', identifier: 'nas', fields: [], changes: [] },
      ],
    })
    expect(items.map((i) => [i.action, i.target, i.fields])).toEqual([
      ['凭据：取用', 'nas', ['password']],
      ['凭据：修改', 'nas', ['说明', 'odd']],
      ['凭据：odd', 'nas', []],
    ])
  })

  it('对象、平台账号与对话缓冲', () => {
    const items = changeItems({
      ...noChanges,
      subjects: 2,
      identities: [
        { kind: 'group', platform: 'bench' },
        { kind: 'person', platform: 'qq' },
      ],
      turns: 1,
    })
    expect(items.map((i) => i.action)).toEqual([
      '新建了 2 个对象',
      '新的平台账号：群 · bench',
      '新的平台账号：人 · qq',
      '写进对话缓冲 1 轮',
    ])
    expect(items[0]!.warnings.join('')).toContain('只能合并')
    expect(items[3]!.notes.join('')).toContain('排抽取')
  })

  it('真实模式下这几项是 null：不列，也不能说成没有改', () => {
    const real: BenchChanges = { ...noChanges, subjects: null, identities: null, turns: null }
    expect(changeItems(real)).toEqual([])
    expect(changesNotListed(real)).toBe(true)
  })
})
