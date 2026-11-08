import { ACTIVITY_FIELDS, type ActivityFacets, type ActivityItem } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  changeSummary,
  dayBounds,
  dayKeyOf,
  dayHeading,
  facetOptions,
  filterQuery,
  gridDays,
  groupByDay,
  MAX_ACTOR_FILTER,
  monthGrid,
  parseState,
  pickDay,
  selectedDays,
  shiftMonth,
  sparkDays,
  stateQuery,
  toggleOff,
} from '../activity'
import activityDetail from '../components/ActivityDetail.vue?raw'
import activityPage from '../pages/ActivityPage.vue?raw'
import { formatClock } from '../time'

// 本地时间：测试机在哪个时区都要过，所以都用本地的年月日时分来造
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString()
const today = '2026-11-08'
const uuid = '0f9c2d6e-1b2a-4c3d-8e4f-5a6b7c8d9e0f'

const item = (id: number, createdAt: string, extra: Partial<ActivityItem> = {}) =>
  ({
    id,
    createdAt,
    type: 'update',
    actorKey: `account:${uuid}`,
    memoryId: `m-${id}`,
    ...extra,
  }) as ActivityItem

describe('一天的小标题', () => {
  it('写月日与星期，今天、昨天另外标出，按本地日期算', () => {
    expect(dayHeading('2026-11-08', today)).toBe('11 月 8 日 · 周日 · 今天')
    expect(dayHeading('2026-11-07', today)).toBe('11 月 7 日 · 周六 · 昨天')
    expect(dayHeading('2026-11-02', today)).toBe('11 月 2 日 · 周一')
  })

  it('不是今年的写上年份；跨年的昨天', () => {
    expect(dayHeading('2025-10-31', today)).toBe('2025 年 10 月 31 日 · 周五')
    expect(dayHeading('2025-12-31', '2026-01-01')).toBe('2025 年 12 月 31 日 · 周三 · 昨天')
  })
})

describe('按天分组与折叠', () => {
  it('同一天的放一组，组的先后和里面的先后不动；翻页后接在同一天后面', () => {
    const days = groupByDay(
      [
        item(5, at(2026, 11, 8, 8), { memoryId: 'a' }),
        item(4, at(2026, 11, 8, 1), { memoryId: 'b' }),
        item(3, at(2026, 11, 7, 23)),
        item(2, at(2026, 10, 28)),
        item(1, at(2025, 10, 28)),
      ],
      today,
    )
    expect(days.map((d) => d.key)).toEqual(['2026-11-08', '2026-11-07', '2026-10-28', '2025-10-28'])
    expect(days[0]!.rows.map((r) => r.item.id)).toEqual([5, 4])
    expect(days[0]!.loaded).toBe(2)
  })

  it('同一个操作者接着修改同一条记忆折叠成一行，别的操作、别人、别的记忆或隔了一条的不折', () => {
    const same = { memoryId: 'm', actorKey: 'bench' }
    const days = groupByDay(
      [
        item(9, at(2026, 11, 8, 10), same),
        item(8, at(2026, 11, 8, 9), same),
        item(7, at(2026, 11, 8, 8), same),
        item(6, at(2026, 11, 8, 7), { ...same, actorKey: `app:${uuid}` }),
        item(5, at(2026, 11, 8, 6), same),
        item(4, at(2026, 11, 8, 5), { ...same, type: 'move' }),
        item(3, at(2026, 11, 8, 4), { ...same, type: 'move' }),
        item(2, at(2026, 11, 7, 23), same),
      ],
      today,
    )
    expect(days[0]!.rows.map((r) => [r.item.id, r.more.map((m) => m.id)])).toEqual([
      [9, [8, 7]],
      [6, []],
      [5, []],
      [4, []],
      [3, []],
    ])
    // 跨天的不折
    expect(days[1]!.rows.map((r) => r.item.id)).toEqual([2])
    expect(days[0]!.loaded).toBe(7)
  })

  it('没有记录时为空', () => {
    expect(groupByDay([], today)).toEqual([])
  })
})

describe('地址里的状态', () => {
  it('什么都没写是近 30 天；写回地址时默认值不写', () => {
    const state = parseState({}, today)
    expect(state).toMatchObject({ range: '30', from: null, to: null, q: '', event: null })
    expect(stateQuery(state)).toEqual({})
    expect(selectedDays(state, today)).toEqual({ from: '2026-10-10', to: today })
  })

  it('自选范围、筛选、关键字与选中的事件来回不变', () => {
    const query = {
      from: '2026-11-01',
      to: '2026-11-05',
      noActor: `app:${uuid},bench`,
      noType: 'delete',
      noLayer: 'user',
      noField: 'content,glossary',
      q: '会话',
      event: '42',
    }
    const state = parseState(query, today)
    expect(state).toMatchObject({
      range: null,
      from: '2026-11-01',
      to: '2026-11-05',
      off: {
        actor: [`app:${uuid}`, 'bench'],
        type: ['delete'],
        layer: ['user'],
        field: ['content', 'glossary'],
      },
      q: '会话',
      event: 42,
    })
    expect(stateQuery(state)).toEqual(query)
  })

  it('写错的值丢掉：反过来的日期换过来，未来的截到今天，太长的截到上限，不认识的筛选值不要', () => {
    expect(parseState({ from: '2026-11-05', to: '2026-11-01' }, today)).toMatchObject({
      from: '2026-11-01',
      to: '2026-11-05',
    })
    expect(parseState({ from: '2026-11-05', to: '2027-01-01' }, today).to).toBe(today)
    expect(parseState({ from: '2020-01-01', to: '2026-11-08' }, today).from).toBe('2025-10-05')
    expect(parseState({ from: '2026-02-30', to: '2026-03-01' }, today).range).toBe('30')
    expect(parseState({ range: 'year' }, today).range).toBe('30')
    expect(parseState({ range: 'all' }, today).range).toBe('all')
    expect(parseState({ noType: 'access,update', noLayer: 'episode' }, today).off).toMatchObject({
      type: ['update'],
      layer: [],
    })
    expect(parseState({ event: '3' }, today).event).toBe(3)
    expect(parseState({ event: '0' }, today).event).toBeNull()
    expect(parseState({ event: 'x' }, today).event).toBeNull()
  })

  it('写法不对的操作者丢掉，超过上限的截掉：接口遇到一个就整个请求 400', () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `account:${uuid.slice(0, -2)}${String(i).padStart(2, '0')}`,
    )
    const state = parseState({ noActor: ['bench', 'key:1', 'app:nope', ...many].join(',') }, today)
    expect(state.off.actor[0]).toBe('bench')
    expect(state.off.actor).not.toContain('key:1')
    expect(state.off.actor).not.toContain('app:nope')
    expect(state.off.actor).toHaveLength(MAX_ACTOR_FILTER)
  })
})

describe('交给接口的筛选', () => {
  it('日期换成本地零点之间的时间；全部时不带', () => {
    const q = filterQuery(parseState({ range: 'today' }, today), today)
    expect(q).toEqual(dayBounds({ from: today, to: today }))
    expect(new Date(q.from!).getTime()).toBe(new Date(2026, 10, 8).getTime())
    expect(new Date(q.to!).getTime()).toBe(new Date(2026, 10, 9).getTime())
    expect(filterQuery(parseState({ range: 'all' }, today), today)).toEqual({})
  })

  it('取消勾选的换成剩下的；字段还带上没有改动字段的；操作者用排除', () => {
    const q = filterQuery(
      parseState(
        { range: 'all', noLayer: 'user,app', noField: 'content', noActor: 'bench', q: 'x' },
        today,
      ),
      today,
    )
    expect(q).toEqual({
      layer: 'core,persona',
      field: 'title,disclosure,priority,sensitivity,layer,uri,glossary,validTo,none',
      exceptActor: 'bench',
      q: 'x',
    })
  })

  it('固定的一组全部取消勾选（手写的地址）当作没有筛选', () => {
    const q = filterQuery(
      parseState({ range: 'all', noLayer: 'core,persona,app,user' }, today),
      today,
    )
    expect(q.layer).toBeUndefined()
  })
})

describe('日历', () => {
  it('从周一开始，补前后的几天；未来的不能选，今天、选中的标出来，条数分档', () => {
    const counts = new Map([
      ['2026-11-02', 1],
      ['2026-11-03', 3],
      ['2026-11-04', 20],
    ])
    const cells = monthGrid('2026-11', today, counts, { from: '2026-11-02', to: '2026-11-03' })
    // 11 月 1 日是周日：前面补上 10 月 26 日到 31 日
    expect(cells[0]!.key).toBe('2026-10-26')
    expect(cells.length % 7).toBe(0)
    expect(cells.at(-1)!.key).toBe('2026-12-06')
    const cell = (key: string) => cells.find((c) => c.key === key)!
    expect(cell('2026-11-08')).toMatchObject({ today: true, future: false, selected: false })
    expect(cell('2026-11-09')).toMatchObject({ future: true, selected: false })
    expect(cell('2026-11-02')).toMatchObject({ selected: true, heat: 1, count: 1 })
    expect(cell('2026-11-03').heat).toBe(2)
    expect(cell('2026-11-04').heat).toBe(4)
    expect(cell('2026-10-26').inMonth).toBe(false)
    // 全部时到今天为止都是选中的
    expect(monthGrid('2026-11', today, counts, null).filter((c) => c.selected).length).toBe(14)
  })

  it('整行都是下个月的不画：2027 年 2 月从周一开始、只有 28 天，只有四行', () => {
    const feb = monthGrid('2027-02', today, new Map(), null)
    expect(feb).toHaveLength(28)
    expect(feb[0]!.key).toBe('2027-02-01')
    expect(feb.at(-1)!.key).toBe('2027-02-28')
    expect(gridDays('2027-02')).toEqual({ from: '2027-02-01', to: '2027-02-28' })
    // 2026 年 3 月从周日开始，要六行
    expect(monthGrid('2026-03', today, new Map(), null)).toHaveLength(42)
  })

  it('一个月的范围、翻月', () => {
    expect(gridDays('2026-11')).toEqual({ from: '2026-10-26', to: '2026-12-06' })
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })

  it('点一天只看那天；Shift 从上次点的那天选到这一天，超出上限时往回截', () => {
    expect(pickDay('2026-11-03', '2026-11-01', false)).toEqual({
      from: '2026-11-03',
      to: '2026-11-03',
    })
    expect(pickDay('2026-11-01', '2026-11-05', true)).toEqual({
      from: '2026-11-01',
      to: '2026-11-05',
    })
    expect(pickDay('2026-11-01', null, true)).toEqual({ from: '2026-11-01', to: '2026-11-01' })
    expect(pickDay('2026-11-08', '2024-01-01', true)).toEqual({
      from: '2025-10-05',
      to: '2026-11-08',
    })
  })

  it('每天的柱条：范围内每一天一根，全部时从最早有改动的那天算', () => {
    const counts = [
      { day: '2026-11-06', count: 2 },
      { day: '2026-11-08', count: 1 },
    ]
    expect(sparkDays({ from: '2026-11-05', to: today }, counts, today)).toEqual([
      { day: '2026-11-05', count: 0 },
      { day: '2026-11-06', count: 2 },
      { day: '2026-11-07', count: 0 },
      { day: '2026-11-08', count: 1 },
    ])
    expect(sparkDays(null, counts, today).map((d) => d.day)[0]).toBe('2026-11-06')
    // 历史很长时留最近的 800 天，右边是今天
    const old = sparkDays(null, [{ day: '2015-01-01', count: 1 }], today)
    expect(old).toHaveLength(800)
    expect(old.at(-1)!.day).toBe(today)
  })
})

describe('筛选的选项', () => {
  it('归属与字段列全，操作只列出现过的与取消勾选的，取消勾选的操作者这次没出现也留着', () => {
    const facets: ActivityFacets = {
      total: 3,
      actors: [{ key: `account:${uuid}`, kind: 'account', name: '林默', count: 3 }],
      types: [{ type: 'update', count: 3 }],
      layers: [{ layer: 'core', count: 3 }],
      fields: [{ field: 'content', count: 2 }],
    }
    const options = facetOptions(facets, {
      actor: ['bench'],
      type: ['delete'],
      layer: [],
      field: [],
    })
    expect(options.actor).toEqual([
      { key: `account:${uuid}`, count: 3 },
      { key: 'bench', count: 0 },
    ])
    expect(options.type.map((t) => t.key)).toEqual(['update', 'delete'])
    expect(options.layer.map((l) => [l.key, l.count])).toEqual([
      ['core', 3],
      ['persona', 0],
      ['app', 0],
      ['user', 0],
    ])
    expect(options.field.find((f) => f.key === 'content')!.count).toBe(2)
    expect(options.field.some((f) => f.key === 'none')).toBe(false)
  })
})

describe('改动的标签', () => {
  it('正文给增删行数，机密的不给；优先级、归属、敏感级写前后', () => {
    expect(changeSummary({ field: 'content', added: 2, removed: 1 })).toBe('+2 −1')
    expect(changeSummary({ field: 'content', added: 1, removed: 0 })).toBe('+1')
    expect(changeSummary({ field: 'content', added: null, removed: null })).toBe('')
    expect(changeSummary({ field: 'priority', before: 1, after: 0 })).toBe('1 → 0')
    expect(changeSummary({ field: 'layer', before: 'core', after: 'user' })).toBe('通用 → 本人')
    expect(changeSummary({ field: 'sensitivity', before: 'internal', after: 'secret' })).toBe(
      '内部 → 机密',
    )
  })

  it('标题、触发场景、坐标、关键词、有效期写成短语', () => {
    expect(changeSummary({ field: 'title', before: 'a', after: 'b' })).toBe('改名')
    expect(changeSummary({ field: 'disclosure', before: null, after: 'x' })).toBe('新增')
    expect(changeSummary({ field: 'disclosure', before: 'x', after: null })).toBe('清除')
    expect(changeSummary({ field: 'disclosure', before: 'x', after: 'y' })).toBe('改写')
    expect(
      changeSummary({
        field: 'uri',
        before: 'core://knowledge/pgvector',
        after: 'core://knowledge/vector/pgvector',
      }),
    ).toBe('…/pgvector → …/vector/pgvector')
    expect(changeSummary({ field: 'uri', before: 'core://a', after: 'core://b' })).toBe(
      'core://a → core://b',
    )
    expect(changeSummary({ field: 'glossary', added: ['语气'], removed: [] })).toBe('+语气')
    expect(changeSummary({ field: 'glossary', added: ['甲方', '乙方'], removed: ['丙方'] })).toBe(
      '+2 −丙方',
    )
    expect(changeSummary({ field: 'validTo', before: null, after: null })).toBe('长期有效')
    expect(changeSummary({ field: 'validTo', before: null, after: at(2026, 12, 1) })).toBe(
      '至 12-01',
    )
  })
})

describe('一行的时间', () => {
  it('补齐两位', () => {
    expect(formatClock(at(2026, 10, 31, 7, 5))).toBe('07:05')
  })
})

describe('至少留一项勾选', () => {
  const listed = [
    { key: 'create', count: 3 },
    { key: 'update', count: 1 },
  ]
  it('按当前列出来的选项判断：看得到的几项不能全取消，没列出来的操作不算数', () => {
    expect(toggleOff(listed, [], 'create', false)).toEqual(['create'])
    expect(toggleOff(listed, ['create'], 'update', false)).toBeNull()
    expect(toggleOff(listed, ['create'], 'create', true)).toEqual([])
    // 地址里取消勾选的、这次没列出来的照样留着
    expect(toggleOff(listed, ['delete'], 'create', false)).toEqual(['delete', 'create'])
  })

  it('字段可以全部取消：只剩没有改动字段的事件', () => {
    const fields = [
      { key: 'content', count: 2 },
      { key: 'title', count: 1 },
    ]
    expect(toggleOff(fields, ['content'], 'title', false, { allowEmpty: true })).toEqual([
      'content',
      'title',
    ])
    const all = parseState({ range: 'all', noField: ACTIVITY_FIELDS.join(',') }, today)
    expect(filterQuery(all, today).field).toBe('none')
  })

  it('操作者最多排除 50 个：再取消一个不改，取消勾选的照样能勾回来', () => {
    const many = Array.from(
      { length: MAX_ACTOR_FILTER },
      (_, i) => `account:${uuid.slice(0, -2)}${String(i).padStart(2, '0')}`,
    )
    const actors = [...many, 'bench'].map((key) => ({ key, count: 1 }))
    expect(toggleOff(actors, many, 'bench', false, { max: MAX_ACTOR_FILTER })).toBeNull()
    expect(toggleOff(actors, many, many[0]!, true, { max: MAX_ACTOR_FILTER })).toHaveLength(
      MAX_ACTOR_FILTER - 1,
    )
  })
})

describe('退回按 UTC 分天', () => {
  it('分组、范围边界都按 UTC', () => {
    // 2026-11-08 00:30 UTC：本地在 UTC 以西时是 11-07，按 UTC 是 11-08
    const iso = '2026-11-08T00:30:00.000Z'
    expect(dayKeyOf(iso, true)).toBe('2026-11-08')
    expect(groupByDay([item(1, iso)], today, true)[0]!.key).toBe('2026-11-08')
    expect(dayBounds({ from: '2026-11-01', to: '2026-11-02' }, true)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-03T00:00:00.000Z',
    })
    const q = filterQuery(parseState({ from: '2026-11-01', to: '2026-11-02' }, today), today, true)
    expect(q.from).toBe('2026-11-01T00:00:00.000Z')
  })
})

describe('详情与时区', () => {
  it('详情按事件 id 读这一条改动，不再取整份历史；增删行数优先用画出来的差异', () => {
    expect(activityDetail).toContain('api.activityEvent(props.spaceId, props.eventId)')
    expect(activityDetail).not.toContain('memoryHistory(')
    expect(activityDetail).toContain('lineCounts(change).added')
    // 逐行对齐算出了差异才用它的行数；正文太长整段对比时用列表的近似值，并写明
    expect(activityDetail).toContain('return diff.value?.complete ? diff.value : change')
    expect(activityDetail).toContain('正文太长，未逐行对齐')
  })

  it('前后快照有正文：不留缓存、每次打开都重取，抹掉历史的地方让它失效', () => {
    expect(activityDetail).toContain('gcTime: 0')
    expect(activityDetail).toContain("refetchOnMount: 'always'")
    const sources = import.meta.glob<string>('../**/*.{vue,ts}', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes('__tests__') || path.endsWith('MemoryHistory.vue')) continue
      if (!source.includes("'memory-history'")) continue
      expect(source.includes("'activity-event'"), path).toBe(true)
    }
  })

  it('详情里的说明与差异是正文，不小于 14px', () => {
    const sizes = [...activityDetail.matchAll(/font-size: (\d+)px/g)].map((m) => Number(m[1]))
    const style = activityDetail.slice(activityDetail.indexOf('<style'))
    for (const cls of ['.detail-note', '.diff']) {
      const block = style.slice(style.indexOf(`${cls} {`))
      expect(Number(/font-size: (\d+)px/.exec(block)![1]), cls).toBeGreaterThanOrEqual(14)
    }
    expect(sizes.length).toBeGreaterThan(0)
  })

  it('服务端不认识浏览器的时区（400）时退回 UTC，并写明按 UTC 分天', () => {
    expect(activityPage).toContain("if (errors.some(tzUnknown)) tz.value = 'UTC'")
    expect(activityPage).toContain('error.status === 400')
    // 只认时区那种 400：别的 400 不退回
    expect(activityPage).toContain('?.code === ACTIVITY_UNKNOWN_TIME_ZONE')
    expect(activityPage).toContain('日历、柱条与表格的日期都按 UTC 分天')
  })
})
