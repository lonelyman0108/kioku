import {
  LAYERS,
  SENSITIVITIES,
  type AccessCell,
  type KeyScopes,
  type Layer,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  STACK,
  accessKind,
  conversationTotal,
  coreCells,
  curatedTotal,
  deepestColumn,
  layerTotal,
  orderRows,
  paintAccess,
  paintCell,
  paintSwatch,
  scopeRows,
  segments,
  sensitivityTotal,
  stackBands,
  tallyCounts,
  textureId,
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

  it('读写的组合对应到说明', () => {
    expect(accessKind('private', cell('recall', true))).toBe('read-write')
    expect(accessKind('private', cell('recall', false))).toBe('read')
    expect(accessKind('private', cell('explicit', false))).toBe('explicit')
    expect(accessKind('private', cell('explicit', true))).toBe('explicit-write')
    expect(accessKind('private', cell('none', true))).toBe('write')
    expect(accessKind('private', cell('none', false))).toBe('none')
  })

  it('来自对话的两层能写时只是抽取写入，不能按 URI 直接写', () => {
    expect(accessKind('subject', cell('recall', true))).toBe('extract')
    expect(accessKind('episode', cell('none', true))).toBe('extract')
    expect(accessKind('episode', cell('recall', false))).toBe('read')
  })

  it('满色能写，淡色只读，抽取写入下沿一条满色，只能按 URI 读取是实心，没权限不画', () => {
    const paint = (kind: Parameters<typeof paintAccess>[2]) =>
      paintAccess('app', 'public', kind, { x: 0, y: 0, width: 10, height: 10 }, { y: 7, height: 3 })
    expect(paint('read-write').map((r) => r.fill)).toEqual(['var(--layer-app)'])
    expect(paint('read')[0]!.fill).toContain('color-mix')
    expect(paint('extract')[1]).toMatchObject({ fill: 'var(--layer-app)', y: 7, height: 3 })
    expect(paint('explicit').map((r) => r.fill)).toEqual(['var(--strata-solid)'])
    expect(paint('none')).toEqual([])
  })

  it('只读格子上的纹理淡一点，读写格子不淡', () => {
    const paint = (kind: 'read' | 'read-write') =>
      paintAccess('app', 'private', kind, { x: 0, y: 0, width: 1, height: 1 }, { y: 0, height: 0 })
    expect(paint('read')[1]!.opacity).toBe(0.55)
    expect(paint('read-write')[1]!.opacity).toBeUndefined()
  })
})

describe('Key 的范围换算成格子', () => {
  const scopes: KeyScopes = {
    readLayers: ['base', 'private', 'subject'],
    writeLayers: ['private', 'subject'],
    maxSensitivity: 'internal',
    admin: false,
  }
  const at = (rows: ReturnType<typeof scopeRows>, layer: Layer, sensitivity: string) =>
    rows.find((r) => r.layer === layer)!.cells.find((c) => c.sensitivity === sensitivity)!

  it('每层每级都有一格', () => {
    const rows = scopeRows(scopes)
    expect(rows.map((r) => r.layer)).toEqual([...LAYERS])
    for (const row of rows) expect(row.cells.map((c) => c.sensitivity)).toEqual([...SENSITIVITIES])
  })

  it('读和写都不超过 Key 的最高敏感级', () => {
    const rows = scopeRows(scopes)
    expect(at(rows, 'private', 'internal')).toMatchObject({ read: 'recall', write: true })
    expect(at(rows, 'private', 'private')).toMatchObject({ read: 'none', write: false })
    expect(at(rows, 'base', 'public')).toMatchObject({ read: 'recall', write: false })
    expect(at(rows, 'app', 'public')).toMatchObject({ read: 'none', write: false })
  })

  it('机密只能按 URI 读取，要 Key 的上限到机密', () => {
    const rows = scopeRows({ ...scopes, maxSensitivity: 'secret' })
    expect(at(rows, 'private', 'secret')).toMatchObject({ read: 'explicit', write: true })
    expect(at(scopeRows(scopes), 'private', 'secret')).toMatchObject({ read: 'none', write: false })
  })

  it('边界线落在碰得到的最高一级，一格都碰不到时是 -1', () => {
    expect(deepestColumn(scopeRows(scopes))).toBe(1)
    expect(deepestColumn(scopeRows({ ...scopes, maxSensitivity: 'secret' }))).toBe(3)
    expect(deepestColumn(scopeRows({ ...scopes, readLayers: [], writeLayers: [] }))).toBe(-1)
  })

  it('接口给的行序统一成地层柱的顺序', () => {
    expect(orderRows(scopeRows(scopes)).map((r) => r.layer)).toEqual([...STACK])
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
    const { columns, cells, bands } = coreCells(scopeRows(scopes), 44, 70, null, 0)
    expect(columns).toEqual([0, 11, 22, 33, 44])
    expect(cells).toHaveLength(28)
    expect(bands.reduce((a, b) => a + b.h, 0)).toBe(70)
  })

  it('格子的权限和位置对得上：纵向是层，横向是敏感级', () => {
    const { cells } = coreCells(scopeRows(scopes), 44, 70, null, 0)
    const secret = cells.find((c) => c.layer === 'private' && c.sensitivity === 'secret')!
    expect(secret.kind).toBe('none')
    expect(secret.x).toBe(33)
    const writable = cells.find((c) => c.layer === 'private' && c.sensitivity === 'private')!
    expect(writable.kind).toBe('read-write')
    expect(cells.find((c) => c.layer === 'base' && c.sensitivity === 'public')!.kind).toBe('read')
  })

  it('下沿的条在格子里面，小格子也至少 2px', () => {
    const { cells } = coreCells(scopeRows(scopes), 44, 21, null, 0)
    for (const cell of cells) {
      expect(cell.barHeight).toBeGreaterThanOrEqual(2)
      expect(cell.barY + cell.barHeight).toBe((cell.y as number) + (cell.height as number))
    }
  })
})
