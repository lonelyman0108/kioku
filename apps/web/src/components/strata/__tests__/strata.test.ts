import {
  LAYERS,
  SENSITIVITIES,
  type AccessCell,
  type KeyScopes,
  type Layer,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'

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
import UriPath from '../UriPath.vue'
import {
  STACK,
  TEXTURES,
  accessKind,
  accessKindLabels,
  columnSize,
  conversationTotal,
  coreCells,
  curatedTotal,
  deepestColumn,
  filteredTotal,
  issuedScopeRows,
  layerTotal,
  orderRows,
  paintAccess,
  paintCell,
  paintSwatch,
  segments,
  sensitivityTotal,
  stackBands,
  tallyCounts,
  textureId,
  type AccessKind,
  type AccessRow,
  type StrataCounts,
} from '../strata'

// 样例和设计稿同一组比例：私人层最大，来自对话的两层只有私密
const sample = (): StrataCounts => ({
  base: { public: 6, internal: 12, private: 0, secret: 0 },
  persona: { public: 9, internal: 14, private: 0, secret: 0 },
  app: { public: 3, internal: 16, private: 2, secret: 0 },
  owner: { public: 0, internal: 11, private: 8, secret: 0 },
  private: { public: 4, internal: 38, private: 72, secret: 9 },
  subject: { public: 0, internal: 0, private: 31, secret: 0 },
  episode: { public: 0, internal: 0, private: 13, secret: 0 },
})

// 极端分布：一层一万条，其余一条或没有
const extreme = (): StrataCounts =>
  tallyCounts([
    { layer: 'private', sensitivity: 'internal', count: 10000 },
    { layer: 'base', sensitivity: 'public', count: 1 },
    { layer: 'app', sensitivity: 'public', count: 1 },
    { layer: 'subject', sensitivity: 'private', count: 1 },
  ])

// 没有组件测试的环境，组件用服务端渲染成 HTML 来看
const render = (component: Component, props: Record<string, unknown>) =>
  renderToString(createSSRApp(component, props))

describe('条数', () => {
  it('接口的分组数合成每层每级的表，没有的是 0', () => {
    const counts = tallyCounts([
      { layer: 'private', sensitivity: 'secret', count: 2 },
      { layer: 'base', sensitivity: 'public', count: 5 },
      { layer: 'base', sensitivity: 'public', count: 1 },
    ])
    expect(counts.private.secret).toBe(2)
    expect(counts.base.public).toBe(6)
    expect(counts.episode.internal).toBe(0)
    expect(Object.keys(counts).sort()).toEqual([...LAYERS].sort())
  })

  it('记忆总数不含来自对话的两层，后者单独算', () => {
    const counts = sample()
    expect(curatedTotal(counts)).toBe(204)
    expect(conversationTotal(counts)).toBe(44)
    expect(layerTotal(counts, 'private')).toBe(123)
    expect(sensitivityTotal(counts, 'private')).toBe(82)
  })
})

describe('按层和敏感级筛选之后的总数', () => {
  it('两个都可以不限；不限层时数 counts 里有的所有层', () => {
    const counts = sample()
    expect(filteredTotal(counts, 'private', 'private')).toBe(72)
    expect(filteredTotal(counts, 'private', null)).toBe(123)
    expect(filteredTotal(counts, null, 'secret')).toBe(9)
    expect(filteredTotal(counts, null, null)).toBe(204 + 44)
  })

  it('列表只给记忆的条数时，来自对话的两层不算', () => {
    const counts = tallyCounts([{ layer: 'base', sensitivity: 'public', count: 3 }])
    expect(filteredTotal(counts, null, null)).toBe(3)
    expect(filteredTotal(counts, 'subject', null)).toBe(0)
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
})

describe('带的高度', () => {
  it('顺序固定：情节在上，基础在下', () => {
    expect(stackBands(sample(), 600, 28).map((b) => b.layer)).toEqual([...STACK])
    expect(STACK[0]).toBe('episode')
    expect(STACK[STACK.length - 1]).toBe('base')
    expect([...STACK].sort()).toEqual([...LAYERS].sort())
  })

  it('带首尾相接，来自对话的两层之后留出间隔，总高正好', () => {
    const bands = stackBands(sample(), 600, 28)
    const byLayer = Object.fromEntries(bands.map((b) => [b.layer, b]))
    expect(byLayer.episode!.y).toBe(0)
    expect(byLayer.subject!.y).toBe(byLayer.episode!.h)
    expect(byLayer.private!.y).toBe(byLayer.subject!.y + byLayer.subject!.h + 28)
    const last = bands[bands.length - 1]!
    expect(last.y + last.h).toBe(600)
    for (let i = 3; i < bands.length; i++) {
      expect(bands[i]!.y).toBe(bands[i - 1]!.y + bands[i - 1]!.h)
    }
  })

  it('高度按条数的平方根：123 条的带不是 13 条的 9 倍高，约 3 倍', () => {
    const bands = stackBands(sample(), 1000, 0)
    const h = (layer: Layer) => bands.find((b) => b.layer === layer)!.h
    expect(h('private') / h('episode')).toBeCloseTo(Math.sqrt(123 / 13), 1)
  })

  it('一层一万条、其余一条或没有时，小层也有最小高度，总高不变，带首尾相接', () => {
    for (const [height, gap, min] of [
      [612, 28, 24],
      [476, 12, 34],
      [72, 3, 6],
    ] as const) {
      const bands = stackBands(extreme(), height, gap, min)
      expect(bands.reduce((a, b) => a + b.h, 0)).toBe(height - gap)
      for (const band of bands.filter((b) => b.layer !== 'private')) expect(band.h).toBe(min)
      expect(bands.find((b) => b.layer === 'private')!.h).toBe(height - gap - 6 * min)
      expect(bands[bands.length - 1]!.y + bands[bands.length - 1]!.h).toBe(height)
    }
  })

  it('不传最小高度时也不会有 0 高的带', () => {
    for (const band of stackBands(extreme(), 40, 3)) expect(band.h).toBeGreaterThanOrEqual(1)
  })

  it('放不下最小高度时平分，比间隔还矮时全是 0，不出现负数', () => {
    expect(stackBands(extreme(), 30, 2, 24).map((b) => b.h)).toEqual([4, 4, 4, 4, 4, 4, 4])
    expect(stackBands(extreme(), 5, 12, 24).map((b) => b.h)).toEqual([0, 0, 0, 0, 0, 0, 0])
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

  it('空的层也占一条，不会消失', () => {
    const counts = sample()
    counts.episode = { public: 0, internal: 0, private: 0, secret: 0 }
    const bands = stackBands(counts, 600, 28)
    expect(bands.find((b) => b.layer === 'episode')!.h).toBeGreaterThan(0)
  })

  it('没有条数时等高', () => {
    const heights = new Set(stackBands(null, 70, 0).map((b) => b.h))
    expect(heights).toEqual(new Set([10]))
  })
})

describe('带内分段', () => {
  it('0 条的不画，顺序从公开到机密，首尾相接，合起来正好是带宽', () => {
    const parts = segments(sample().private, 216, 2)
    expect(parts.map((p) => p.sensitivity)).toEqual(['public', 'internal', 'private', 'secret'])
    let x = 0
    for (const p of parts) {
      expect(p.x).toBe(x)
      x += p.w
    }
    expect(x).toBe(216)
    expect(segments(sample().subject, 216, 2)).toEqual([
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
    expect(paintCell('base', 'public', box).map((r) => r.fill)).toEqual(['var(--layer-base)'])
    expect(paintCell('base', 'internal', box).map((r) => r.fill)).toEqual([
      'var(--layer-base)',
      `url(#${textureId('internal', 'lg')})`,
    ])
    expect(paintCell('base', 'private', box, 'sm').map((r) => r.fill)).toEqual([
      'var(--layer-base)',
      `url(#${textureId('private', 'sm')})`,
    ])
    expect(paintCell('base', 'secret', box).map((r) => r.fill)).toEqual(['var(--strata-solid)'])
  })

  it('小色块上的机密留一条层色，否则看不出是哪一层', () => {
    const rects = paintSwatch('private', 'secret', 18, 12)
    expect(rects[0]!.fill).toBe('var(--strata-solid)')
    expect(rects[1]).toMatchObject({ fill: 'var(--layer-private)', width: 5 })
  })

  it('没有层时用中性底色（图例），没有敏感级时只画层色', () => {
    expect(paintSwatch(null, 'public', 18, 12)[0]!.fill).toBe('var(--strata-neutral)')
    expect(paintSwatch('app', null, 18, 12).map((r) => r.fill)).toEqual(['var(--layer-app)'])
  })
})

describe('权限格子', () => {
  const cell = (read: AccessCell['read'], write: boolean): AccessCell => ({ read, write })
  const KINDS = Object.keys(accessKindLabels) as AccessKind[]
  const box = { x: 0, y: 0, width: 10, height: 10 }
  const bar = { y: 7, height: 3 }

  it('读写的组合对应到说明', () => {
    expect(accessKind('private', cell('recall', true))).toBe('read-write')
    expect(accessKind('private', cell('recall', false))).toBe('read')
    expect(accessKind('private', cell('explicit', false))).toBe('explicit')
    expect(accessKind('private', cell('explicit', true))).toBe('explicit-write')
    expect(accessKind('private', cell('none', true))).toBe('write')
    expect(accessKind('private', cell('none', false))).toBe('none')
  })

  it('来自对话的两层能写只是抽取写入，不能说成普通的写，读权限照样看', () => {
    for (const layer of ['subject', 'episode'] as const) {
      expect(accessKind(layer, cell('recall', true))).toBe('read-extract')
      expect(accessKind(layer, cell('recall', false))).toBe('read')
      expect(accessKind(layer, cell('explicit', true))).toBe('explicit-extract')
      expect(accessKind(layer, cell('explicit', false))).toBe('explicit')
      expect(accessKind(layer, cell('none', true))).toBe('extract')
      expect(accessKind(layer, cell('none', false))).toBe('none')
    }
  })

  it('文字说清每一种', () => {
    expect(accessKindLabels).toEqual({
      'read-write': '读写',
      'read-extract': '读取且抽取写入',
      read: '只读',
      'explicit-write': '按 URI 读取且可写',
      'explicit-extract': '按 URI 读取且抽取写入',
      explicit: '仅按 URI 读取',
      write: '仅写入',
      extract: '仅抽取写入',
      none: '无权限',
    })
    expect(new Set(Object.values(accessKindLabels)).size).toBe(KINDS.length)
  })

  it('每种权限的画法两两不同：岩芯上没有文字，图例里一个色块也只能对应一种说法', () => {
    for (const layer of LAYERS) {
      for (const sensitivity of SENSITIVITIES) {
        for (const scale of ['lg', 'sm'] as const) {
          const painted = KINDS.map((kind) =>
            JSON.stringify(paintAccess(layer, sensitivity, kind, box, bar, scale)),
          )
          expect(new Set(painted).size, `${layer} ${sensitivity} ${scale}`).toBe(KINDS.length)
        }
      }
    }
  })

  it('底色说怎么读：满色能读能写，淡色读得到但不能直接写，实心只能按 URI 读取，读不到的没有底色', () => {
    const paint = (kind: AccessKind) => paintAccess('app', 'public', kind, box, bar)
    const solid = { ...box, fill: 'var(--strata-explicit)' }
    expect(paint('read-write').map((r) => r.fill)).toEqual(['var(--layer-app)'])
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
      paintAccess('app', 'public', kind, box, bar, 'sm').filter((r) => r.y === bar.y)
    const full = { ...box, ...bar, fill: 'var(--layer-app)' }
    const gaps = { ...box, ...bar, fill: `url(#${TEXTURES.gaps.sm})` }
    for (const kind of ['write', 'explicit-write'] as const) expect(paint(kind)).toEqual([full])
    for (const kind of ['extract', 'read-extract', 'explicit-extract'] as const) {
      expect(paint(kind)).toEqual([full, gaps])
    }
    for (const kind of ['read-write', 'read', 'explicit', 'none'] as const) {
      expect(paint(kind)).toEqual([])
    }
  })

  it('读得到的格子上，条画在敏感级的纹理上面', () => {
    const rects = paintAccess('app', 'private', 'read-extract', box, bar, 'sm')
    expect(rects.map((r) => r.fill)).toEqual([
      expect.stringContaining('color-mix'),
      `url(#${textureId('private', 'sm')})`,
      'var(--layer-app)',
      `url(#${TEXTURES.gaps.sm})`,
    ])
  })

  it('权限的实心块和机密的实心块是两个令牌：调权限格子不能带着全站的机密一起变', () => {
    expect(paintAccess('app', 'secret', 'explicit', box, bar)[0]!.fill).toBe(
      'var(--strata-explicit)',
    )
    expect(paintCell('app', 'secret', box)[0]!.fill).toBe('var(--strata-solid)')
  })

  it('用到的纹理都有定义', async () => {
    const html = await render(StrataPatterns, {})
    for (const scales of Object.values(TEXTURES)) {
      for (const id of Object.values(scales)) expect(html).toContain(`id="${id}"`)
    }
  })

  it('只读格子上的纹理淡一点，读写格子不淡', () => {
    const paint = (kind: 'read' | 'read-write') =>
      paintAccess('app', 'private', kind, { x: 0, y: 0, width: 1, height: 1 }, { y: 0, height: 0 })
    expect(paint('read')[1]!.opacity).toBe(0.55)
    expect(paint('read-write')[1]!.opacity).toBeUndefined()
  })

  it('矩阵的图例：每种权限一个色块，色块互不相同', async () => {
    const row = (layer: Layer, cells: AccessCell[]): AccessRow => ({
      layer,
      cells: cells.map((c, i) => ({ ...c, sensitivity: SENSITIVITIES[i]! })),
    })
    const html = await render(AccessMatrix, {
      rows: [
        row('private', [
          cell('recall', true),
          cell('recall', false),
          cell('explicit', false),
          cell('explicit', true),
        ]),
        row('base', [
          cell('none', true),
          cell('none', false),
          cell('none', false),
          cell('none', false),
        ]),
        row('subject', [
          cell('recall', true),
          cell('explicit', true),
          cell('none', true),
          cell('none', false),
        ]),
      ],
    })
    const legend = html.slice(html.indexOf('mx-legend'))
    const items = [...legend.matchAll(/<li[^>]*>(<svg.*?<\/svg>)<span[^>]*>(.*?)<\/span>/g)]
    expect(items.map((m) => m[2]).sort()).toEqual(Object.values(accessKindLabels).sort())
    expect(new Set(items.map((m) => m[1])).size).toBe(KINDS.length)
  })
})

describe('Key 的签发范围换算成格子', () => {
  const scopes: KeyScopes = {
    readLayers: ['base', 'private', 'subject'],
    writeLayers: ['private', 'subject'],
    maxSensitivity: 'internal',
    admin: false,
  }
  const at = (rows: ReturnType<typeof issuedScopeRows>, layer: Layer, sensitivity: string) =>
    rows.find((r) => r.layer === layer)!.cells.find((c) => c.sensitivity === sensitivity)!

  it('每层每级都有一格', () => {
    const rows = issuedScopeRows(scopes)
    expect(rows.map((r) => r.layer)).toEqual([...LAYERS])
    for (const row of rows) expect(row.cells.map((c) => c.sensitivity)).toEqual([...SENSITIVITIES])
  })

  it('读和写都不超过 Key 的最高敏感级', () => {
    const rows = issuedScopeRows(scopes)
    expect(at(rows, 'private', 'internal')).toMatchObject({ read: 'recall', write: true })
    expect(at(rows, 'private', 'private')).toMatchObject({ read: 'none', write: false })
    expect(at(rows, 'base', 'public')).toMatchObject({ read: 'recall', write: false })
    expect(at(rows, 'app', 'public')).toMatchObject({ read: 'none', write: false })
  })

  it('机密只能按 URI 读取，要 Key 的上限到机密', () => {
    const rows = issuedScopeRows({ ...scopes, maxSensitivity: 'secret' })
    expect(at(rows, 'private', 'secret')).toMatchObject({ read: 'explicit', write: true })
    expect(at(issuedScopeRows(scopes), 'private', 'secret')).toMatchObject({
      read: 'none',
      write: false,
    })
  })

  it('边界线落在碰得到的最高一级，一格都碰不到时是 -1', () => {
    expect(deepestColumn(issuedScopeRows(scopes))).toBe(1)
    expect(deepestColumn(issuedScopeRows({ ...scopes, maxSensitivity: 'secret' }))).toBe(3)
    expect(deepestColumn(issuedScopeRows({ ...scopes, readLayers: [], writeLayers: [] }))).toBe(-1)
  })

  it('接口给的行序统一成地层柱的顺序', () => {
    expect(orderRows(issuedScopeRows(scopes)).map((r) => r.layer)).toEqual([...STACK])
  })
})

describe('岩芯', () => {
  const scopes: KeyScopes = {
    readLayers: [...LAYERS],
    writeLayers: ['private'],
    maxSensitivity: 'private',
    admin: false,
  }

  it('四列铺满宽度，七条带铺满高度，一共 28 格', () => {
    const { columns, cells, bands } = coreCells(issuedScopeRows(scopes), 44, 70, null, 0)
    expect(columns).toEqual([0, 11, 22, 33, 44])
    expect(cells).toHaveLength(28)
    expect(bands.reduce((a, b) => a + b.h, 0)).toBe(70)
  })

  it('格子的权限和位置对得上：纵向是层，横向是敏感级', () => {
    const { cells } = coreCells(issuedScopeRows(scopes), 44, 70, null, 0)
    const secret = cells.find((c) => c.layer === 'private' && c.sensitivity === 'secret')!
    expect(secret.kind).toBe('none')
    expect(secret.x).toBe(33)
    const writable = cells.find((c) => c.layer === 'private' && c.sensitivity === 'private')!
    expect(writable.kind).toBe('read-write')
    expect(cells.find((c) => c.layer === 'base' && c.sensitivity === 'public')!.kind).toBe('read')
  })

  it('下沿的条在格子里面，小格子也至少 2px', () => {
    const { cells } = coreCells(issuedScopeRows(scopes), 44, 21, null, 0)
    for (const cell of cells) {
      expect(cell.barHeight).toBeGreaterThanOrEqual(2)
      expect(cell.barY + cell.barHeight).toBe((cell.y as number) + (cell.height as number))
    }
  })

  it('条数相差悬殊时小层的格子还在，条不画到别的带上', () => {
    const { bands, cells } = coreCells(issuedScopeRows(scopes), 44, 72, extreme())
    for (const band of bands) expect(band.h).toBeGreaterThanOrEqual(6)
    expect(cells).toHaveLength(28)
    for (const cell of cells) {
      expect(cell.height).toBeGreaterThanOrEqual(6)
      expect(cell.barY).toBeGreaterThanOrEqual(cell.y as number)
    }
  })

  it('格子比 2px 还矮时，条也不超出格子', () => {
    const { cells } = coreCells(issuedScopeRows(scopes), 44, 7, null, 0)
    for (const cell of cells) {
      expect(cell.height).toBe(1)
      expect(cell.barHeight).toBe(1)
      expect(cell.barY).toBe(cell.y)
    }
  })

  it('读屏和悬停读到的是签发范围，不说成实际权限', async () => {
    const html = await render(StrataCore, { scopes })
    expect(html).toContain('aria-label="签发范围：可读 7 层，可写 1 层，最高私密"')
    expect(html).toContain('<title>签发范围：可读 7 层，可写 1 层，最高私密</title>')
  })

  it('传了服务端算的 rows 就说是当前上下文的范围，哪怕也传了 scopes', async () => {
    const rows = issuedScopeRows(scopes)
    expect(await render(StrataCore, { rows, scopes })).toContain(
      'aria-label="当前会话上下文的权限范围"',
    )
  })

  it('已吊销：一格都不上色，读屏和悬停都说明已吊销，不再读范围', async () => {
    const html = await render(StrataCore, { scopes, revoked: true })
    expect(html).toContain('aria-label="已吊销，没有权限"')
    expect(html).toContain('<title>已吊销，没有权限</title>')
    expect(html).not.toContain('可读')
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

  it('一层的合计能点，这一层没有记忆时不能点', async () => {
    const counts = sample()
    counts.episode = { public: 0, internal: 0, private: 0, secret: 0 }
    const html = await render(StrataColumn, { counts })
    expect(html).toContain('aria-label="私人 123 条"')
    expect(html).not.toMatch(/<button[^>]*aria-label="情节 0 条"/)
  })
})

describe('窄柱', () => {
  it('条数读到之前带等高、不写数字，筛选照样能点', async () => {
    const html = await render(StrataRibbon, { counts: null, length: 400 })
    expect(html.match(/<button[^>]*class="rb-band/g)).toHaveLength(7)
    expect(html).toContain('aria-label="私人"')
    expect(html).not.toContain('条')
    expect(html).not.toContain('<b>')
  })

  it('选中的层、当前记忆所在的层都标出来', async () => {
    const html = await render(StrataRibbon, {
      counts: sample(),
      length: 600,
      selected: 'private',
      current: 'base',
    })
    const band = (label: string) =>
      html.split('<button').find((chunk) => chunk.includes(`aria-label="${label}"`))!
    expect(band('私人 123 条')).toContain('class="on rb-band"')
    expect(band('私人 123 条')).toContain('aria-pressed="true"')
    expect(band('基础 18 条')).toContain('aria-pressed="false"')
    expect(band('基础 18 条')).toContain('rb-here')
    expect(band('私人 123 条')).not.toContain('rb-here')
  })
})

describe('记忆的标记', () => {
  const priority = (n: number) => `P${n}`

  it('优先级只标最高的两档，机密带文字', async () => {
    expect(await render(MemoryFlags, { priority: 0 })).toContain(priority(0))
    expect(await render(MemoryFlags, { priority: 1 })).toContain(priority(1))
    expect(await render(MemoryFlags, { priority: 2 })).not.toContain(priority(2))
    expect(await render(MemoryFlags, { sensitivity: 'secret' })).toContain('机密')
    expect(await render(MemoryFlags, { sensitivity: 'private' })).not.toContain('flag-secret')
  })

  it('层写简称，色块不单独说明是哪一层', async () => {
    expect(await render(MemoryFlags, { layer: 'owner' })).toContain('画像')
  })

  it('机密的标记和标签都不用红', async () => {
    for (const file of ['../MemoryFlags.vue?raw', '../StrataTag.vue?raw']) {
      const css = (await import(/* @vite-ignore */ file)).default as string
      expect(css, file).not.toContain('--ui-error')
    }
  })
})

describe('URI', () => {
  it('上一级路径和名字分开，悬停看得到全部', async () => {
    const html = await render(UriPath, { uri: 'projects://atlas/release' })
    expect(html).toContain('<span class="uri-parent"')
    expect(html).toContain('projects://atlas/</span>')
    expect(html).toContain('release</span>')
    expect(html).toContain('title="projects://atlas/release"')
  })
})

describe('详情的标签和条带', () => {
  it('标签写全层和敏感级的名字，纹理跟着敏感级', async () => {
    const html = await render(StrataTag, { layer: 'private', sensitivity: 'private' })
    expect(html).toContain('私人')
    expect(html).toContain('私密')
    expect(html).toContain('--layer-private')
    expect(html).toContain(`url(#${TEXTURES.lines.lg})`)
  })

  it('机密的条带和标签是实心，看不出层色的地方靠文字', async () => {
    expect(await render(StrataStrip, { layer: 'private', sensitivity: 'secret' })).toContain(
      '--strata-solid',
    )
    const html = await render(StrataTag, { layer: 'private', sensitivity: 'secret' })
    expect(html).toContain('私人')
    expect(html).toContain('机密')
    expect(html).toContain('--strata-solid')
  })

  it('条带不读屏，文字在标签里', async () => {
    expect(await render(StrataStrip, { layer: 'base', sensitivity: 'public' })).toContain(
      'aria-hidden="true"',
    )
  })
})

describe('带色块的单选', () => {
  const options = [
    { value: null, label: '按层默认', bare: true },
    { value: 'public', label: '公开', layer: 'private', sensitivity: 'public' },
    { value: 'secret', label: '机密', layer: 'private', sensitivity: 'secret' },
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
      layer: 'base',
      sensitivity: 'public',
      decorative: true,
    })
    expect(html).toContain('aria-hidden="true"')
    expect(html).not.toContain('title=')
    expect(await render(StrataSwatch, { layer: 'base', sensitivity: 'public' })).toContain(
      'aria-label="基础 公开"',
    )
  })
})

describe('状态行', () => {
  it('语气只在文字上', async () => {
    const html = await render(NoteLine, { tone: 'warning' })
    expect(html).toContain('class="warning note-title"')
  })
})

describe('要放文字的带', () => {
  const sizes = (html: string, name: string, prop: 'height' | 'width') =>
    [...html.matchAll(new RegExp(`class="[^"]*\\b${name}\\b[^"]*"[^>]*${prop}:(\\d+)px`, 'g'))].map(
      (m) => Number(m[1]),
    )

  it('地层柱的每一行放得下层名和数字按钮', async () => {
    const rows = sizes(await render(StrataColumn, { counts: extreme() }), 'fig-row', 'height')
    expect(rows).toHaveLength(7)
    for (const h of rows) expect(h).toBeGreaterThanOrEqual(24)
  })

  it('窄柱的每条带放得下两行标签，放倒时放得下三个字的简称', async () => {
    const standing = await render(StrataRibbon, { counts: extreme(), length: 400 })
    const heights = sizes(standing, 'rb-band', 'height')
    expect(heights).toHaveLength(7)
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(34)
    const lying = await render(StrataRibbon, {
      counts: extreme(),
      length: 343,
      orientation: 'horizontal',
    })
    const widths = sizes(lying, 'rb-band', 'width')
    expect(widths).toHaveLength(7)
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(38)
  })

  it('窄柱的边框不会有负的尺寸，哪怕放不下', async () => {
    for (const length of [50, 56, 60, 400]) {
      const html = await render(StrataRibbon, { counts: extreme(), length })
      expect(html, String(length)).not.toMatch(/(height|width)="-/)
    }
  })
})
