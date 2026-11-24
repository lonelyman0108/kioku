import {
  SENSITIVITIES,
  STRATA_BANDS,
  sensitivityAllowed,
  type AccessCell,
  type CircleAccessMatrix,
  type EntryKind,
  type LensKeyScopes,
  type Sensitivity,
  type StrataBand,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { bandLabels, entryKindLabels, sensitivityLabels } from '../../../labels'
import AccessLegend from '../AccessLegend.vue'
import AccessMatrix from '../AccessMatrix.vue'
import MemoryFlags from '../MemoryFlags.vue'
import NoteLine from '../NoteLine.vue'
import StrataColumn from '../StrataColumn.vue'
import StrataCore from '../StrataCore.vue'
import StrataPatterns from '../StrataPatterns.vue'
import StrataRibbon from '../StrataRibbon.vue'
import StrataStrip from '../StrataStrip.vue'
import StrataSwatch from '../StrataSwatch.vue'
import StrataTag from '../StrataTag.vue'
import SwatchOptions from '../SwatchOptions.vue'
import {
  ACCESS_BAR_PERCENT,
  DASHES,
  STACK,
  TEXTURES,
  accessBar,
  accessCellText,
  accessFill,
  accessKind,
  accessKindLabels,
  bandSensitivityAllowed,
  bandTotal,
  columnSize,
  conversationTotal,
  coreCells,
  coreMark,
  coreName,
  curatedTotal,
  dashId,
  deepestColumn,
  filteredTotal,
  isConversationBand,
  issuedBandRows,
  issuedScopeRows,
  matrixToBandRows,
  orderRows,
  paintAccess,
  paintCell,
  paintSwatch,
  presentKinds,
  segments,
  sensitivityTotal,
  stackBands,
  tallyCounts,
  textureId,
  type AccessKind,
  type BandAccessRow,
  type StrataCounts,
} from '../strata'

const sample = (): StrataCounts => ({
  primary: { public: 6, internal: 12, private: 0, secret: 0 },
  persona: { public: 9, internal: 14, private: 0, secret: 0 },
  'shared-away': { public: 3, internal: 16, private: 2, secret: 0 },
  personal: { public: 0, internal: 53, private: 80, secret: 9 },
  fact: { public: 0, internal: 0, private: 31, secret: 0 },
  episode: { public: 0, internal: 0, private: 13, secret: 0 },
})

const extreme = (): StrataCounts =>
  tallyCounts([
    { band: 'personal', sensitivity: 'internal', count: 10000 },
    { band: 'primary', sensitivity: 'public', count: 1 },
    { band: 'shared-away', sensitivity: 'public', count: 1 },
    { band: 'fact', sensitivity: 'private', count: 1 },
  ])

const render = (component: Component, props: Record<string, unknown>) =>
  renderToString(createSSRApp(component, props))

describe('条数', () => {
  it('按色带与概览计数合成每带每级的表，没有的是 0', () => {
    const counts = tallyCounts({
      circleKind: 'shared',
      counts: [
        { kind: 'entry', sensitivity: 'public', count: 5 },
        { kind: 'entry', sensitivity: 'internal', count: 1 },
      ],
      extractedCounts: [{ kind: 'fact', sensitivity: 'public', count: 3 }],
      personalCounts: [{ kind: 'entry', sensitivity: 'secret', count: 2 }],
    })
    expect(counts.personal.secret).toBe(2)
    expect(counts.primary.public).toBe(5)
    expect(counts.primary.internal).toBe(1)
    expect(counts.fact.public).toBe(3)
    expect(counts.episode.internal).toBe(0)
    expect(Object.keys(counts).sort()).toEqual([...STRATA_BANDS].sort())
  })

  it('词条总数不含来自对话的两类，后者单独算', () => {
    const counts = sample()
    expect(curatedTotal(counts)).toBe(204)
    expect(conversationTotal(counts)).toBe(44)
    expect(bandTotal(counts, 'personal')).toBe(142)
    expect(sensitivityTotal(counts, 'private')).toBe(82)
  })
})

describe('按色带和敏感级筛选之后的总数', () => {
  it('两个都可以不限；不限色带时数 counts 里有的所有条目', () => {
    const counts = sample()
    expect(filteredTotal(counts, 'personal', 'private')).toBe(80)
    expect(filteredTotal(counts, 'personal', null)).toBe(142)
    expect(filteredTotal(counts, null, 'secret')).toBe(9)
    expect(filteredTotal(counts, null, null)).toBe(204 + 44)
  })

  it('列表只给词条条数时，来自对话的两类不算', () => {
    const counts = tallyCounts([{ band: 'primary', sensitivity: 'public', count: 3 }])
    expect(filteredTotal(counts, null, null)).toBe(3)
    expect(filteredTotal(counts, 'fact', null)).toBe(0)
  })
})

describe('概览里地层柱的尺寸', () => {
  it('宽屏跟着视口高度，一屏放下，再矮也不小于 440，再高也不超过 680', () => {
    expect(columnSize({ width: 1440, height: 900 })).toEqual({
      width: 216,
      height: 612,
      compact: false,
    })
    expect(columnSize({ width: 1440, height: 500 }).height).toBe(440)
    expect(columnSize({ width: 1440, height: 2000 }).height).toBe(680)
  })

  it('单栏时高度固定，放不下数字的窄屏换紧凑版', () => {
    expect(columnSize({ width: 800, height: 2000 })).toEqual({
      width: 216,
      height: 470,
      compact: false,
    })
    expect(columnSize({ width: 390, height: 844 })).toEqual({
      width: 92,
      height: 470,
      compact: true,
    })
  })

  it('按放柱子的容器宽度判断：视口够宽、容器放不下数字时也换紧凑版', () => {
    expect(columnSize({ width: 756, height: 900 }, 378).compact).toBe(true)
    expect(columnSize({ width: 1440, height: 900 }, 519).compact).toBe(true)
    expect(columnSize({ width: 1440, height: 900 }, 520).compact).toBe(false)
  })
})

describe('带的高度', () => {
  it('顺序固定：会话在上，主场在下', () => {
    expect(stackBands(sample(), 600, 28).map((b) => b.band)).toEqual([...STACK])
    expect(STACK).toEqual(['episode', 'fact', 'personal', 'shared-away', 'persona', 'primary'])
    expect([...STACK].sort()).toEqual([...STRATA_BANDS].sort())
  })

  it('带首尾相接，来自对话的两类之后留出间隔，总高正好', () => {
    const bands = stackBands(sample(), 600, 28)
    const byBand = Object.fromEntries(bands.map((b) => [b.band, b]))
    expect(byBand.episode!.y).toBe(0)
    expect(byBand.fact!.y).toBe(byBand.episode!.h)
    expect(byBand.personal!.y).toBe(byBand.fact!.y + byBand.fact!.h + 28)
    const last = bands[bands.length - 1]!
    expect(last.y + last.h).toBe(600)
    for (let i = 3; i < bands.length; i++) {
      expect(bands[i]!.y).toBe(bands[i - 1]!.y + bands[i - 1]!.h)
    }
  })

  it('高度按条数的平方根：142 条的带不是 13 条的 11 倍高，约 3 倍', () => {
    const bands = stackBands(sample(), 1000, 0)
    const h = (band: StrataBand) => bands.find((b) => b.band === band)!.h
    expect(h('personal') / h('episode')).toBeCloseTo(Math.sqrt(142 / 13), 1)
  })

  it('一类一万条、其余一条或没有时，小的也有最小高度，总高不变，带首尾相接', () => {
    for (const [height, gap, min] of [
      [612, 28, 24],
      [476, 12, 34],
      [72, 3, 6],
    ] as const) {
      const bands = stackBands(extreme(), height, gap, min)
      expect(bands.reduce((a, b) => a + b.h, 0)).toBe(height - gap)
      for (const band of bands.filter((b) => b.band !== 'personal')) expect(band.h).toBe(min)
      expect(bands.find((b) => b.band === 'personal')!.h).toBe(height - gap - 5 * min)
      expect(bands[bands.length - 1]!.y + bands[bands.length - 1]!.h).toBe(height)
    }
  })

  it('不传最小高度时也不会有 0 高的带', () => {
    for (const band of stackBands(extreme(), 40, 3)) expect(band.h).toBeGreaterThanOrEqual(1)
  })

  it('放不下最小高度时平分，比间隔还矮时全是 0，不出现负数', () => {
    expect(stackBands(extreme(), 26, 2, 24).map((b) => b.h)).toEqual([4, 4, 4, 4, 4, 4])
    expect(stackBands(extreme(), 5, 12, 24).map((b) => b.h)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('量出来的高度带小数时也是整数像素，合起来不超出可用高度', () => {
    for (const [height, total] of [
      [520.25, 508],
      [520.75, 508],
    ] as const) {
      const bands = stackBands(sample(), height, 12, 34)
      expect(bands.every((b) => Number.isInteger(b.h))).toBe(true)
      expect(bands.reduce((a, b) => a + b.h, 0)).toBe(total)
    }
  })

  it('空的色带也占一条，不会消失', () => {
    const counts = sample()
    counts.episode = { public: 0, internal: 0, private: 0, secret: 0 }
    const bands = stackBands(counts, 600, 28)
    expect(bands.find((b) => b.band === 'episode')!.h).toBeGreaterThan(0)
  })

  it('没有条数时等高', () => {
    const heights = new Set(stackBands(null, 66, 0).map((b) => b.h))
    expect(heights).toEqual(new Set([11]))
  })
})

describe('带内分段', () => {
  it('0 条的不画，顺序从公开到机密，首尾相接，合起来正好是带宽', () => {
    const parts = segments({ public: 4, internal: 38, private: 72, secret: 9 }, 216, 2)
    expect(parts.map((p) => p.sensitivity)).toEqual(['public', 'internal', 'private', 'secret'])
    let x = 0
    for (const p of parts) {
      expect(p.x).toBe(x)
      x += p.w
    }
    expect(x).toBe(216)
    expect(segments(sample().fact, 216, 2)).toEqual([
      { sensitivity: 'private', count: 31, x: 0, w: 216 },
    ])
  })

  it('段宽按条数', () => {
    const parts = segments({ public: 1, internal: 3, private: 0, secret: 0 }, 200, 1)
    expect(parts.map((p) => p.w)).toEqual([50, 150])
  })

  it('很小的段留出最小宽度，从别的段里匀，总宽不变', () => {
    const parts = segments({ public: 1, internal: 1000, private: 1, secret: 1 }, 26, 2)
    expect(parts.map((p) => p.w)).toEqual([2, 20, 2, 2])
  })

  it('宽度不够每段最小值时也不超出', () => {
    const parts = segments({ public: 1, internal: 1, private: 1, secret: 1 }, 3, 2)
    expect(parts.reduce((a, p) => a + p.w, 0)).toBe(3)
  })

  it('全是 0 或没有宽度时什么都不画', () => {
    expect(segments({ public: 0, internal: 0, private: 0, secret: 0 }, 100)).toEqual([])
    expect(segments({ public: 1, internal: 0, private: 0, secret: 0 }, 0)).toEqual([])
  })
})

describe('上色', () => {
  const box = { x: 0, y: 0, width: 10, height: 10 }

  it('敏感级靠纹理：公开无纹理，内部圆点，私密斜线，机密实心', () => {
    expect(paintCell('primary', 'public', box).map((r) => r.fill)).toEqual(['var(--layer-primary)'])
    expect(paintCell('primary', 'internal', box).map((r) => r.fill)).toEqual([
      'var(--layer-primary)',
      `url(#${textureId('internal', 'lg')})`,
    ])
    expect(paintCell('primary', 'private', box, 'sm').map((r) => r.fill)).toEqual([
      'var(--layer-primary)',
      `url(#${textureId('private', 'sm')})`,
    ])
    expect(paintCell('primary', 'secret', box).map((r) => r.fill)).toEqual(['var(--strata-solid)'])
  })

  it('小色块上的机密留一条色带，否则看不出属于哪一类', () => {
    const rects = paintSwatch('personal', 'secret', 18, 12)
    expect(rects[0]!.fill).toBe('var(--strata-solid)')
    expect(rects[1]).toMatchObject({ fill: 'var(--layer-personal)', width: 5 })
  })

  it('没有色带时用中性底色（图例），没有敏感级时只画色带底色', () => {
    expect(paintSwatch(null, 'public', 18, 12)[0]!.fill).toBe('var(--strata-neutral)')
    expect(paintSwatch('shared-away', null, 18, 12).map((r) => r.fill)).toEqual([
      'var(--layer-shared-away)',
    ])
  })
})

describe('权限格子', () => {
  const cell = (read: AccessCell['read'], write: boolean): AccessCell => ({ read, write })
  const KINDS = Object.keys(accessKindLabels) as AccessKind[]
  const box = { x: 0, y: 0, width: 10, height: 10 }
  const bar = { y: 7, height: 3 }

  it('读写的组合对应到说明', () => {
    expect(accessKind('personal', cell('recall', true))).toBe('read-write')
    expect(accessKind('personal', cell('recall', false))).toBe('read')
    expect(accessKind('personal', cell('explicit', false))).toBe('explicit')
    expect(accessKind('personal', cell('explicit', true))).toBe('explicit-write')
    expect(accessKind('personal', cell('none', true))).toBe('write')
    expect(accessKind('personal', cell('none', false))).toBe('none')
  })

  it('来自对话的两类能写只是抽取写入，不能说成普通的写，读权限照样看', () => {
    for (const band of ['fact', 'episode'] as const) {
      expect(accessKind(band, cell('recall', true))).toBe('read-extract')
      expect(accessKind(band, cell('recall', false))).toBe('read')
      expect(accessKind(band, cell('explicit', true))).toBe('explicit-extract')
      expect(accessKind(band, cell('explicit', false))).toBe('explicit')
      expect(accessKind(band, cell('none', true))).toBe('extract')
      expect(accessKind(band, cell('none', false))).toBe('none')
    }
  })

  it('文字说清每一种', () => {
    expect(accessKindLabels).toEqual({
      'read-write': '读写',
      'read-extract': '读取且抽取写入',
      read: '只读',
      'explicit-write': '按短 ID 读取且可写',
      'explicit-extract': '按短 ID 读取且抽取写入',
      explicit: '仅按短 ID 读取',
      write: '仅写入',
      extract: '仅抽取写入',
      none: '无权限',
    })
    expect(new Set(Object.values(accessKindLabels)).size).toBe(KINDS.length)
  })

  it('每种权限的画法两两不同：岩芯上没有文字，图例里一个色块也只能对应一种说法', () => {
    for (const band of STRATA_BANDS) {
      for (const sensitivity of SENSITIVITIES) {
        for (const scale of ['lg', 'sm'] as const) {
          const painted = KINDS.map((kind) =>
            JSON.stringify(paintAccess(band, sensitivity, kind, box, bar, scale)),
          )
          expect(new Set(painted).size, `${band} ${sensitivity} ${scale}`).toBe(KINDS.length)
        }
      }
    }
  })

  it('底色说怎么读：满色能读能写，淡色读得到但不能直接写，实心只能按短 ID 读取，读不到的没有底色', () => {
    const paint = (kind: AccessKind) => paintAccess('shared-away', 'public', kind, box, bar)
    const solid = { ...box, fill: 'var(--strata-explicit)' }
    expect(paint('read-write').map((r) => r.fill)).toEqual(['var(--access-shared-away)'])
    for (const kind of ['read', 'read-extract'] as const) {
      expect(paint(kind)[0]).toMatchObject(box)
      expect(paint(kind)[0]!.fill).toContain('color-mix')
    }
    for (const kind of ['explicit', 'explicit-write', 'explicit-extract'] as const) {
      expect(paint(kind)[0]).toEqual(solid)
    }
    expect(paint('none')).toEqual([])
    for (const kind of ['write', 'extract'] as const) {
      for (const rect of paint(kind)) expect(rect).toMatchObject(bar)
    }
  })

  it('下沿的条说怎么写：满色的条能写，虚线的条只能靠抽取写入', () => {
    const paint = (kind: AccessKind) =>
      paintAccess('shared-away', 'public', kind, box, bar, 'sm').filter((r) => r.y === bar.y)
    const full = { ...box, ...bar, fill: 'var(--access-shared-away)' }
    const dashed = { ...box, ...bar, fill: `url(#${dashId('shared-away', 'sm')})` }
    for (const kind of ['write', 'explicit-write'] as const) expect(paint(kind)).toEqual([full])
    for (const kind of ['extract', 'read-extract', 'explicit-extract'] as const) {
      expect(paint(kind)).toEqual([dashed])
    }
    for (const kind of ['read-write', 'read', 'explicit', 'none'] as const) {
      expect(paint(kind)).toEqual([])
    }
  })

  it('读得到的格子上，条画在敏感级的纹理上面', () => {
    const rects = paintAccess('shared-away', 'private', 'read-extract', box, bar, 'sm')
    expect(rects.map((r) => r.fill)).toEqual([
      expect.stringContaining('color-mix'),
      `url(#${textureId('private', 'sm')})`,
      `url(#${dashId('shared-away', 'sm')})`,
    ])
  })

  it('有虚线条时纹理只铺到条上面：缺口里露出底色，不是一半的圆点', () => {
    const numeric = paintAccess('shared-away', 'internal', 'read-extract', box, bar, 'sm')
    expect(numeric[1]).toMatchObject({ y: 0, height: 7 })
    const shifted = paintAccess(
      'shared-away',
      'internal',
      'read-extract',
      { x: 0, y: 20, width: 10, height: 10 },
      { y: 27, height: 3 },
      'sm',
    )
    expect(shifted[1]).toMatchObject({ y: 20, height: 7 })
    const percent = paintAccess(
      'shared-away',
      'internal',
      'read-extract',
      { x: 0, y: 0, width: '100%', height: '100%' },
      ACCESS_BAR_PERCENT,
      'lg',
    )
    expect(percent[1]).toMatchObject({ y: 0, height: '80%' })
    expect(paintAccess('shared-away', 'internal', 'read', box, bar, 'sm')[1]).toMatchObject(box)
  })

  it('虚线条的缺口真的留空：只画实的那几段，不是用页面底色盖上去的', async () => {
    const html = await render(StrataPatterns, {})
    expect(html).not.toContain('--ui-bg')
    expect(html).not.toContain('strata-gap')
    for (const band of STRATA_BANDS) {
      for (const scale of ['lg', 'sm'] as const) {
        const { on, off } = DASHES[scale]
        const pattern = new RegExp(
          `<pattern id="${dashId(band, scale)}" width="${on + off}"[^>]*><rect width="${on}"[^>]*style="fill:${accessFill(band).replace(/[()]/g, '\\$&')};?"`,
        )
        expect(html, `${band} ${scale}`).toMatch(pattern)
      }
    }
  })

  it('虚线的实虚比例、下沿的条占格子的比例，大小图形都一样', () => {
    expect(DASHES.lg.on / DASHES.lg.off).toBe(DASHES.sm.on / DASHES.sm.off)
    expect(ACCESS_BAR_PERCENT).toEqual({ y: '80%', height: '20%' })
    expect(accessBar(0, 36)).toEqual({ y: 29, height: 7 })
    expect(accessBar(0, 18)).toEqual({ y: 14, height: 4 })
    expect(accessBar(5, 10)).toEqual({ y: 13, height: 2 })
  })

  it('条最少 2px，也不比格子高', () => {
    expect(accessBar(0, 6).height).toBe(2)
    expect(accessBar(0, 1)).toEqual({ y: 0, height: 1 })
  })

  it('权限的实心块和机密的实心块是两个令牌：调权限格子不能带着全站的机密一起变', () => {
    expect(paintAccess('shared-away', 'secret', 'explicit', box, bar)[0]!.fill).toBe(
      'var(--strata-explicit)',
    )
    expect(paintCell('shared-away', 'secret', box)[0]!.fill).toBe('var(--strata-solid)')
  })

  it('用到的纹理都有定义', async () => {
    const html = await render(StrataPatterns, {})
    for (const scales of Object.values(TEXTURES)) {
      for (const id of Object.values(scales)) expect(html).toContain(`id="${id}"`)
    }
  })

  it('只读格子上的纹理淡一点，读写格子不淡', () => {
    const paint = (kind: 'read' | 'read-write') =>
      paintAccess(
        'shared-away',
        'private',
        kind,
        { x: 0, y: 0, width: 1, height: 1 },
        { y: 0, height: 0 },
      )
    expect(paint('read')[1]!.opacity).toBe(0.55)
    expect(paint('read-write')[1]!.opacity).toBeUndefined()
  })

  it('矩阵的图例：每种权限一个色块，色块互不相同', async () => {
    const row = (band: StrataBand, cells: AccessCell[]): BandAccessRow => ({
      band,
      cells: cells.map((c, i) => ({ ...c, sensitivity: SENSITIVITIES[i]! })),
    })
    const html = await render(AccessMatrix, {
      rows: [
        row('shared-away', [
          cell('recall', true),
          cell('recall', false),
          cell('explicit', false),
          cell('explicit', true),
        ]),
        row('primary', [
          cell('none', true),
          cell('none', false),
          cell('none', false),
          cell('none', false),
        ]),
        row('fact', [
          cell('recall', true),
          cell('explicit', true),
          cell('none', true),
          cell('none', false),
        ]),
      ],
    })
    expect(html).toContain('mx-legend')
    const legend = html.slice(html.indexOf('mx-legend'))
    const items = [...legend.matchAll(/<li[^>]*>(<svg.*?<\/svg>)<span[^>]*>(.*?)<\/span>/g)]
    expect(items.map((m) => m[2]).sort()).toEqual(Object.values(accessKindLabels).sort())
    expect(new Set(items.map((m) => m[1])).size).toBe(KINDS.length)
  })
})

describe('多圈权限范围矩阵与色带投影', () => {
  const READS = ['none', 'explicit', 'recall'] as const
  const WRITES = [true, false]
  const singleBand = (
    band: StrataBand,
    sensitivity: Sensitivity,
    read: AccessCell['read'],
    write: boolean,
  ): BandAccessRow[] =>
    STRATA_BANDS.map((b) => ({
      band: b,
      cells: SENSITIVITIES.map((s) =>
        b === band && s === sensitivity
          ? { sensitivity: s, read, write }
          : { sensitivity: s, read: 'none' as const, write: false },
      ),
    }))
  const expected = (band: StrataBand, read: AccessCell['read'], write: boolean) => {
    const writing = !write ? '' : isConversationBand(band) ? 'extract' : 'write'
    return (
      {
        recall: { write: '读写', extract: '读取且抽取写入', '': '只读' },
        explicit: {
          write: '按短 ID 读取且可写',
          extract: '按短 ID 读取且抽取写入',
          '': '仅按短 ID 读取',
        },
        none: { write: '仅写入', extract: '仅抽取写入', '': '无权限' },
      } as const
    )[read][writing]
  }
  const combos = STRATA_BANDS.flatMap((band) =>
    SENSITIVITIES.filter((sensitivity) => bandSensitivityAllowed(band, sensitivity)).flatMap(
      (sensitivity) =>
        READS.flatMap((read) => WRITES.map((write) => ({ band, sensitivity, read, write }))),
    ),
  )
  const cellHtml = (html: string, label: string, sensitivity: Sensitivity) => {
    const title = `title="${label} ${sensitivityLabels[sensitivity]}：`
    const at = html.indexOf(title)
    expect(at, `${label} ${sensitivity}`).toBeGreaterThan(0)
    return html.slice(html.lastIndexOf('<td', at), html.indexOf('</td>', at))
  }

  it('多圈矩阵：按主场与客场分组展示物种权限，会话摘要机密写不适用', async () => {
    const mkRow = (kind: EntryKind, read: AccessCell['read'], write: boolean) => ({
      kind,
      cells: SENSITIVITIES.map((sensitivity) => ({ sensitivity, read, write })),
    })
    const circles: CircleAccessMatrix[] = [
      {
        circleId: '00000000-0000-4000-8000-000000000001',
        circleName: '工作圈',
        circleKind: 'shared',
        isPrimary: true,
        credentials: 'use',
        rows: [
          mkRow('entry', 'recall', true),
          mkRow('fact', 'recall', false),
          mkRow('episode', 'none', true),
        ],
      },
      {
        circleId: '00000000-0000-4000-8000-000000000002',
        circleName: '个人圈',
        circleKind: 'personal',
        isPrimary: false,
        credentials: 'none',
        rows: [
          mkRow('entry', 'recall', false),
          mkRow('fact', 'none', false),
          mkRow('episode', 'none', false),
        ],
      },
    ]
    const html = await render(AccessMatrix, { circles })
    expect(html).toContain('工作圈')
    expect(html).toContain('主圈')
    expect(html).toContain('凭据取用')
    expect(html).toContain('个人圈')
    expect(html).toContain('关联圈')
    expect(cellHtml(html, entryKindLabels.episode, 'secret')).toContain('不适用')
    const projected = matrixToBandRows(circles)
    expect(projected.find((r) => r.band === 'primary')!.cells[0]!.write).toBe(true)
    expect(projected.find((r) => r.band === 'personal')!.cells[0]!.read).toBe('recall')
  })

  it('色带矩阵：每一格的文字、标题、色块都和模型一致', async () => {
    for (const { band, sensitivity, read, write } of combos) {
      const name = `${band} ${sensitivity} ${read} ${write}`
      const html = await render(AccessMatrix, { rows: singleBand(band, sensitivity, read, write) })
      const cell = cellHtml(html, bandLabels[band], sensitivity)
      const text = expected(band, read, write)
      expect(cell, name).toContain(`：${text}"`)
      expect(cell, name).toContain(`>${text}</span>`)
      const kind = accessKind(band, { read, write })
      const rects = paintAccess(
        band,
        sensitivity,
        kind,
        { x: 0, y: 0, width: '100%', height: '100%' },
        ACCESS_BAR_PERCENT,
        'lg',
      )
      expect(cell.match(/<rect/g)?.length ?? 0, name).toBe(rects.length)
      if (read === 'none' && !write) expect(cell, name).not.toContain('<svg')
      for (const other of SENSITIVITIES.filter((s) => s !== sensitivity)) {
        expect(cellHtml(html, bandLabels[band], other), name).toContain(
          bandSensitivityAllowed(band, other) ? '：无权限"' : '：不适用，',
        )
      }
    }
  })

  it('会话摘要 × 机密写不适用：这一级不存在，和没给权限分开', async () => {
    for (const read of READS) {
      for (const write of WRITES) {
        const html = await render(AccessMatrix, {
          rows: singleBand('episode', 'secret', read, write),
        })
        const cell = cellHtml(html, '会话摘要', 'secret')
        expect(cell).toContain('title="会话摘要 机密：不适用，会话摘要不设机密"')
        expect(cell).toContain('>不适用</span>')
        expect(cell).not.toContain('<svg')
        expect(cell).not.toContain('无权限')
      }
    }
  })

  it('岩芯：每一格的画法和模型一致，别的格子不上色', async () => {
    for (const { band, sensitivity, read, write } of combos) {
      const name = `${band} ${sensitivity} ${read} ${write}`
      const rows = singleBand(band, sensitivity, read, write)
      const html = await render(StrataCore, { rows, width: 44, height: 72 })
      const kind = accessKind(band, { read, write })
      const { cells } = coreCells(rows, 44, 72, null, 3)
      const target = cells.find((c) => c.band === band && c.sensitivity === sensitivity)!
      expect(target.kind, name).toBe(kind)
      expect(target.x, name).toBe(Math.round((SENSITIVITIES.indexOf(sensitivity) / 4) * 44))
      const painted = paintAccess(
        band,
        sensitivity,
        kind,
        { x: target.x, y: target.y, width: target.width, height: target.height },
        { y: target.barY, height: target.barHeight },
        'sm',
      )
      const fills = [...html.matchAll(/style="fill:([^;"]+);?"/g)]
        .map((m) => m[1]!.trim())
        .filter((fill) => fill !== 'var(--ui-bg)')
      expect(fills, name).toEqual(painted.map((r) => r.fill))
    }
  })

  it('读屏读到的是接口给的范围，不是前端算的', async () => {
    const rows = singleBand('shared-away', 'public', 'recall', true)
    const html = await render(StrataCore, { rows, label: '群聊' })
    expect(html).toContain('aria-label="群聊的访问范围"')
  })
})

describe('图例', () => {
  it('只列这份权限里出现的，读写、只读、无权限一直在', () => {
    const rows: BandAccessRow[] = [
      {
        band: 'fact',
        cells: [{ sensitivity: 'public', read: 'recall', write: true }],
      },
    ]
    expect(presentKinds([])).toEqual(['read-write', 'read', 'none'])
    expect(presentKinds(rows)).toEqual(['read-write', 'read-extract', 'read', 'none'])
  })

  it('色块和格子同一种画法：下沿的条按同一个比例', async () => {
    const html = await render(AccessLegend, { kinds: ['write'] })
    const bar = accessBar(0, 18)
    expect(html).toContain(`y="${bar.y}"`)
    expect(html).toContain(`height="${bar.height}"`)
    expect(html).toContain('仅写入')
  })
})

describe('矩阵在窄宽度下', () => {
  it('文字不折行，放不下时由外层横向滚动，每行一样高', async () => {
    const css = (await import('../AccessMatrix.vue?raw')).default as string
    const rule = (selector: string) =>
      new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)![1]!
    expect(rule('.mx-scroll')).toContain('overflow-x: auto')
    expect(rule('.mx')).toContain('table-layout: auto')
    expect(rule('.mx')).not.toContain('min-width')
    expect(rule('.c')).toContain('white-space: nowrap')
    expect(rule('.c')).toContain('height: 36px')
  })
})

describe('访问密钥的签发范围换算成格子', () => {
  const scopes: LensKeyScopes = {
    readKinds: ['entry', 'fact'],
    writeKinds: ['entry', 'fact'],
    maxSensitivity: 'internal',
    allowedRealms: null,
    admin: false,
    credentials: 'none',
  }
  const at = (
    rows: ReturnType<typeof issuedScopeRows>,
    kind: EntryKind,
    sensitivity: Sensitivity,
  ) => rows.find((r) => r.kind === kind)!.cells.find((c) => c.sensitivity === sensitivity)!

  it('每类每级都有一格，按物种给出 3 行', () => {
    const rows = issuedScopeRows(scopes)
    expect(rows.map((r) => r.kind)).toEqual(['episode', 'fact', 'entry'])
    for (const row of rows) expect(row.cells.map((c) => c.sensitivity)).toEqual([...SENSITIVITIES])
  })

  it('读和写都不超过密钥的最高敏感级，个人圈正式词条允许公开', () => {
    const rows = issuedScopeRows(scopes, 'personal')
    expect(at(rows, 'entry', 'public')).toMatchObject({ read: 'recall', write: true })
    expect(at(rows, 'entry', 'internal')).toMatchObject({ read: 'recall', write: true })
    expect(at(rows, 'entry', 'private')).toMatchObject({ read: 'none', write: false })
    expect(at(rows, 'episode', 'public')).toMatchObject({ read: 'none', write: false })
  })

  it('机密只能按短 ID 读取，会话摘要不设机密', () => {
    const rows = issuedScopeRows({
      ...scopes,
      readKinds: ['entry', 'fact', 'episode'],
      writeKinds: ['entry', 'fact', 'episode'],
      maxSensitivity: 'secret',
    })
    expect(at(rows, 'entry', 'secret')).toMatchObject({ read: 'explicit', write: true })
    expect(at(rows, 'episode', 'secret')).toMatchObject({ read: 'none', write: false })
    expect(sensitivityAllowed('personal', 'episode', 'secret')).toBe(false)
  })

  it('边界线落在碰得到的最高一级，一格都碰不到时是 -1', () => {
    expect(deepestColumn(issuedScopeRows(scopes))).toBe(1)
    expect(deepestColumn(issuedScopeRows({ ...scopes, maxSensitivity: 'secret' }))).toBe(3)
    expect(deepestColumn(issuedScopeRows({ ...scopes, readKinds: [], writeKinds: [] }))).toBe(-1)
  })

  it('接口给的色带行序统一成地层柱的顺序', () => {
    expect(orderRows(issuedBandRows(scopes)).map((r) => r.band)).toEqual([...STACK])
  })
})

describe('岩芯', () => {
  const scopes: LensKeyScopes = {
    readKinds: ['entry', 'fact', 'episode'],
    writeKinds: ['entry'],
    maxSensitivity: 'private',
    allowedRealms: null,
    admin: false,
    credentials: 'none',
  }

  it('格子的说明：写明色带、敏感级与权限；会话摘要 × 机密写不适用', () => {
    expect(accessCellText('personal', 'private', 'read-write')).toBe('个人圈记忆 私密：读写')
    expect(accessCellText('primary', 'secret', 'explicit')).toBe('主圈记忆 机密：仅按短 ID 读取')
    expect(accessCellText('episode', 'secret', 'none')).toBe(
      '会话摘要 机密：不适用，会话摘要不设机密',
    )
  })

  it('可交互时每一格都有命中区，读屏读到这一格的说明；默认不带', async () => {
    const plain = await render(StrataCore, { scopes })
    expect(plain).not.toContain('core-hit')
    const html = await render(StrataCore, { scopes, interactive: true })
    expect(html.match(/class="core-hit"/g)).toHaveLength(24)
    expect(html).toContain('aria-label="会话摘要 机密：不适用，会话摘要不设机密"')
    expect(await render(StrataCore, { scopes, interactive: true, revoked: true })).not.toContain(
      'core-hit',
    )
  })

  it('四列铺满宽度，六条带铺满高度，一共 24 格', () => {
    const { columns, cells, bands } = coreCells(issuedBandRows(scopes), 44, 70, null, 0)
    expect(columns).toEqual([0, 11, 22, 33, 44])
    expect(cells).toHaveLength(24)
    expect(bands.reduce((a, b) => a + b.h, 0)).toBe(70)
  })

  it('格子的权限和位置对得上：纵向是色带，横向是敏感级', () => {
    const { cells } = coreCells(
      issuedBandRows(scopes, { primaryKind: 'shared', linkedKinds: ['personal'] }),
      44,
      70,
      null,
      0,
    )
    const secret = cells.find((c) => c.band === 'primary' && c.sensitivity === 'secret')!
    expect(secret.kind).toBe('none')
    expect(secret.x).toBe(33)
    const writable = cells.find((c) => c.band === 'primary' && c.sensitivity === 'private')!
    expect(writable.kind).toBe('read-write')
    expect(cells.find((c) => c.band === 'personal' && c.sensitivity === 'public')!.kind).toBe(
      'read',
    )
  })

  it('下沿的条在格子里面，小格子也至少 2px', () => {
    const { cells } = coreCells(issuedBandRows(scopes), 44, 21, null, 0)
    for (const cell of cells) {
      expect(cell.barHeight).toBeGreaterThanOrEqual(2)
      expect(cell.barY + cell.barHeight).toBe((cell.y as number) + (cell.height as number))
    }
  })

  it('条数相差悬殊时小的色带的格子还在，条不画到别的带上', () => {
    const { bands, cells } = coreCells(issuedBandRows(scopes), 44, 72, extreme())
    for (const band of bands) expect(band.h).toBeGreaterThanOrEqual(6)
    expect(cells).toHaveLength(24)
    for (const cell of cells) {
      expect(cell.height).toBeGreaterThanOrEqual(6)
      expect(cell.barY).toBeGreaterThanOrEqual(cell.y as number)
    }
  })

  it('格子比 2px 还矮时，条也不超出格子', () => {
    const { cells } = coreCells(issuedBandRows(scopes), 44, 6, null, 0)
    for (const cell of cells) {
      expect(cell.height).toBe(1)
      expect(cell.barHeight).toBe(1)
      expect(cell.barY).toBe(cell.y)
    }
  })

  it('读屏和悬停读到的是签发范围，不说成实际权限', async () => {
    const html = await render(StrataCore, { scopes })
    expect(html).toContain('aria-label="签发范围：读 3 类，写 1 类，至私密"')
    expect(html).toContain('<title>签发范围：读 3 类，写 1 类，至私密</title>')
  })

  it('传了服务端算的 rows 就说是当前上下文的范围，哪怕也传了 scopes', async () => {
    const rows = issuedBandRows(scopes)
    expect(await render(StrataCore, { rows, scopes })).toContain(
      'aria-label="当前会话上下文的访问范围"',
    )
  })

  it('带 label 时说清是谁的，也说清是签发范围', async () => {
    const html = await render(StrataCore, { scopes, label: 'MacBook' })
    expect(html).toContain('aria-label="MacBook，签发范围：读 3 类，写 1 类，至私密"')
    const rows = issuedBandRows(scopes)
    expect(await render(StrataCore, { rows, label: '群聊' })).toContain(
      'aria-label="群聊的访问范围"',
    )
  })

  it('没有数据时不读成访问范围，框是虚线，和没有权限的岩芯分得开', async () => {
    const html = await render(StrataCore, {})
    expect(html).toContain('aria-label="暂无权限数据"')
    expect(html).not.toContain('访问范围')
    expect(html.match(/stroke-dasharray="3 2"/g)).toHaveLength(2)
    expect(await render(StrataCore, { label: 'MacBook' })).toContain(
      'aria-label="MacBook，暂无权限数据"',
    )
    expect(coreName({ rows: null, scopes: null })).toBe('暂无权限数据')
    const none = issuedBandRows({ ...scopes, readKinds: [], writeKinds: [] })
    const blank = await render(StrataCore, { rows: none })
    expect(blank).toContain('aria-label="当前会话上下文的访问范围"')
    expect(blank.match(/stroke-dasharray="3 2"/g)).toHaveLength(1)
  })

  it('标记落在这一色带这一级的格子上；不知道敏感级时标整条带', () => {
    const model = coreCells(issuedBandRows(scopes), 44, 72)
    const band = model.bands.find((b) => b.band === 'personal')!
    expect(coreMark(model, 'personal', 'private')).toEqual({
      x: 22.5,
      y: band.y + 0.5,
      width: 10,
      height: band.h - 1,
    })
    expect(coreMark(model, 'personal', null)).toEqual({
      x: 0.5,
      y: band.y + 0.5,
      width: 43,
      height: band.h - 1,
    })
  })

  it('已吊销：一格都不上色，读屏和悬停都说明已吊销，不再读范围', async () => {
    const html = await render(StrataCore, { scopes, revoked: true })
    expect(html).toContain('aria-label="已吊销，没有权限"')
    expect(html).toContain('<title>已吊销，没有权限</title>')
    expect(html).not.toContain('签发范围')
    expect(html).not.toContain('--layer-')
    expect(await render(StrataCore, { scopes, revoked: true, label: '旧笔记本' })).toContain(
      'aria-label="旧笔记本，已吊销，没有权限"',
    )
  })
})

describe('地层柱', () => {
  it('机密的条数不用红色，红色只留给告警', async () => {
    const css = (await import('../StrataColumn.vue?raw')).default as string
    const rule = /\.fig-n\.sec \{([^}]*)\}/.exec(css)![1]!
    expect(rule).not.toContain('error')
  })

  it('一类的合计能点，这一类没有记忆时不能点；单圈视角按 3 条色带绘制并显示正式记忆', async () => {
    const counts = sample()
    counts.episode = { public: 0, internal: 0, private: 0, secret: 0 }
    const html = await render(StrataColumn, { counts })
    expect(html).toContain('aria-label="个人圈记忆 142 条"')
    expect(html).not.toMatch(/<button[^>]*aria-label="会话摘要 0 条"/)
    const localHtml = await render(StrataColumn, {
      counts,
      circleKind: 'personal',
    })
    expect(localHtml).toContain('aria-label="正式记忆 142 条"')
    expect(localHtml).not.toContain('关联圈记忆')
    expect(localHtml).not.toContain('独立人格')
  })
})

describe('窄柱', () => {
  it('条数读到之前带等高、不写数字，筛选照样能点；单圈模式仅画 3 条真实色带', async () => {
    const html = await render(StrataRibbon, { counts: null, length: 400 })
    expect(html.match(/<button[^>]*class="rb-band/g)).toHaveLength(6)
    expect(html).toContain('aria-label="个人圈记忆"')
    expect(html).not.toMatch(/\d+ 条/)
    expect(html).not.toContain('<b>')
    const localRibbon = await render(StrataRibbon, {
      counts: null,
      length: 300,
      circleKind: 'shared',
    })
    expect(localRibbon.match(/<button[^>]*class="rb-band/g)).toHaveLength(3)
    expect(localRibbon).toContain('aria-label="正式记忆"')
  })

  it('顶上的「全部」读到条数之后也不写总数', async () => {
    const html = await render(StrataRibbon, { counts: sample(), length: 600 })
    const all = html.split('<button').find((chunk) => /class="[^"]*\brb-all\b/.test(chunk))!
    expect(all.slice(0, all.indexOf('</button>'))).toMatch(/>\s*<span[^>]*>全部<\/span>\s*$/)
  })

  it('选中的色带、当前记忆所在的色带都标出来', async () => {
    const html = await render(StrataRibbon, {
      counts: sample(),
      length: 600,
      selected: 'personal',
      current: 'primary',
    })
    const band = (label: string) =>
      html.split('<button').find((chunk) => chunk.includes(`aria-label="${label}"`))!
    expect(band('个人圈记忆 142 条')).toContain('class="on rb-band"')
    expect(band('个人圈记忆 142 条')).toContain('aria-pressed="true"')
    expect(band('主圈记忆 18 条')).toContain('aria-pressed="false"')
    expect(band('主圈记忆 18 条')).toContain('rb-here')
    expect(band('个人圈记忆 142 条')).not.toContain('rb-here')
  })
})

describe('记忆的标记', () => {
  const priority = (n: number) => `P${n}`

  it('优先级只标最高的两档，机密带文字，多变体显示数量', async () => {
    expect(await render(MemoryFlags, { priority: 0 })).toContain(priority(0))
    expect(await render(MemoryFlags, { priority: 1 })).toContain(priority(1))
    expect(await render(MemoryFlags, { priority: 2 })).not.toContain(priority(2))
    expect(await render(MemoryFlags, { sensitivity: 'secret' })).toContain('机密')
    expect(await render(MemoryFlags, { sensitivity: 'private' })).not.toContain('flag-secret')
    expect(await render(MemoryFlags, { variantCount: 3 })).toContain('3 变体')
  })

  it('写色带的名字，单圈内省去冗余正式记忆尾标、保留对话形态标签', async () => {
    expect(await render(MemoryFlags, { band: 'personal' })).toContain('个人圈记忆')
    expect(await render(MemoryFlags, { band: 'personal', local: true })).not.toContain('个人圈记忆')
    expect(await render(MemoryFlags, { band: 'fact', local: true })).toContain('联系人事实')
  })

  it('机密的标记和标签都不用红', async () => {
    for (const file of ['../MemoryFlags.vue?raw', '../StrataTag.vue?raw']) {
      const css = (await import(/* @vite-ignore */ file)).default as string
      expect(css, file).not.toContain('--ui-error')
    }
  })
})

describe('详情的标签和条带', () => {
  it('标签写全色带和敏感级的名字，单圈内支持显示形态名，纹理跟着敏感级', async () => {
    const html = await render(StrataTag, { band: 'personal', sensitivity: 'private' })
    expect(html).toContain('个人圈记忆')
    expect(html).toContain('私密')
    expect(html).toContain('--layer-personal')
    expect(html).toContain(`url(#${TEXTURES.lines.lg})`)
    const localTag = await render(StrataTag, {
      band: 'personal',
      sensitivity: 'private',
      local: true,
    })
    expect(localTag).toContain('正式记忆')
  })

  it('机密的条带和标签是实心，看不出底色的地方靠文字', async () => {
    expect(await render(StrataStrip, { band: 'personal', sensitivity: 'secret' })).toContain(
      '--strata-solid',
    )
    const html = await render(StrataTag, { band: 'personal', sensitivity: 'secret' })
    expect(html).toContain('个人圈记忆')
    expect(html).toContain('机密')
    expect(html).toContain('--strata-solid')
  })

  it('条带不读屏，文字在标签里', async () => {
    expect(await render(StrataStrip, { band: 'primary', sensitivity: 'public' })).toContain(
      'aria-hidden="true"',
    )
  })
})

describe('带色块的单选', () => {
  const options = [
    { value: null, label: '默认项', bare: true },
    { value: 'public', label: '公开', band: 'primary' as const, sensitivity: 'public' as const },
    { value: 'secret', label: '机密', band: 'primary' as const, sensitivity: 'secret' as const },
  ]

  it('当前的选中，每一项都有文字，色块不读屏', async () => {
    const html = await render(SwatchOptions, { label: '敏感级', options, modelValue: 'public' })
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="敏感级"')
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(html.match(/checked/g)).toHaveLength(1)
    for (const option of options) expect(html).toContain(option.label)
    expect(html).not.toContain('role="img"')
  })

  it('没有色块的那一项不画，没有选中的值也能显示', async () => {
    const html = await render(SwatchOptions, { label: '敏感级', options, modelValue: null })
    expect(html.match(/<svg/g)).toHaveLength(2)
  })

  it('色块标成配图时不读屏也不弹说明', async () => {
    const html = await render(StrataSwatch, {
      band: 'primary',
      sensitivity: 'public',
      decorative: true,
    })
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('title=')
    expect(await render(StrataSwatch, { band: 'primary', sensitivity: 'public' })).toContain(
      'aria-label="主圈记忆 公开"',
    )
  })
})

describe('状态行', () => {
  it('语气只在文字上', async () => {
    const html = await render(NoteLine, { tone: 'warning' })
    expect(html).toContain('class="warning note-title"')
  })

  it('上面已经有线时不再画墨线，默认照常画', async () => {
    expect(await render(NoteLine, { flush: true })).toMatch(/class="[^"]*\bflush\b/)
    expect(await render(NoteLine, {})).not.toContain('flush')
  })
})

describe('要放文字的带', () => {
  const sizes = (html: string, name: string, prop: 'height' | 'width') =>
    [...html.matchAll(new RegExp(`class="[^"]*\\b${name}\\b[^"]*"[^>]*${prop}:(\\d+)px`, 'g'))].map(
      (m) => Number(m[1]),
    )

  it('地层柱的每一行放得下标签和数字按钮', async () => {
    const rows = sizes(await render(StrataColumn, { counts: extreme() }), 'fig-row', 'height')
    expect(rows).toHaveLength(6)
    for (const h of rows) expect(h).toBeGreaterThanOrEqual(24)
  })

  it('窄柱的每条带放得下两行标签，放倒时放得下名字', async () => {
    const standing = await render(StrataRibbon, { counts: extreme(), length: 400 })
    const heights = sizes(standing, 'rb-band', 'height')
    expect(heights).toHaveLength(6)
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(34)
    const lying = await render(StrataRibbon, {
      counts: extreme(),
      length: 343,
      orientation: 'horizontal',
    })
    const widths = sizes(lying, 'rb-band', 'width')
    expect(widths).toHaveLength(6)
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(38)
  })

  it('窄柱的边框不会有负的尺寸，哪怕放不下', async () => {
    for (const length of [50, 56, 60, 400]) {
      const html = await render(StrataRibbon, { counts: extreme(), length })
      expect(html, String(length)).not.toMatch(/(height|width)="-/)
    }
  })
})
