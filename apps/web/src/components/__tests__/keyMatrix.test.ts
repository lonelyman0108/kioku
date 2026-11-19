import {
  ACCESS_CONTEXTS,
  ENTRY_KINDS,
  SENSITIVITIES,
  type CircleAccessMatrix,
  type KeyAccessMatrix,
  type KeyInfo,
} from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { keyMatrixKey } from '../../appQueries'
import {
  accessContextLabels,
  entryKindLabels,
  originScopeLabels,
  sensitivityLabels,
} from '../../labels'
import KeyMatrix from '../KeyMatrix.vue'

vi.mock('../Hint.vue', () => ({ default: defineComponent({ render: () => h('i') }) }))

const CIRCLE = '00000000-0000-4000-8000-0000000000s1'
const CLIENT = '00000000-0000-4000-8000-0000000000c1'
const KEY = '00000000-0000-4000-8000-000000000001'

const keyInfo = (over: Partial<KeyInfo> = {}): KeyInfo => {
  const scopes = {
    readKinds: [...ENTRY_KINDS],
    writeKinds: [...ENTRY_KINDS],
    maxSensitivity: 'private' as const,
    allowedRealms: null,
    admin: false,
    credentials: 'none' as const,
  }
  return {
    id: KEY,
    clientId: CLIENT,
    name: 'MacBook',
    prefix: 'kk_a',
    linkedCircles: [],
    contextFacets: {},
    personaOverrideId: null,
    scopes,
    effectiveScopes: scopes,
    circleGrants: [],
    createdAt: '2026-10-01T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  }
}

const circleMatrix = (i: number): CircleAccessMatrix => ({
  circleId: CIRCLE,
  circleName: '工作圈',
  circleKind: 'shared',
  isPrimary: true,
  credentials: i === 0 ? 'use' : 'none',
  rows: ENTRY_KINDS.map((kind) => ({
    kind,
    cells: SENSITIVITIES.map((sensitivity) => ({
      sensitivity,
      read:
        kind === 'entry' && sensitivity === 'public'
          ? (['recall', 'explicit', 'recall', 'explicit', 'none'] as const)[i]!
          : ('none' as const),
      write: kind === 'entry' && sensitivity === 'public' && i % 2 === 0,
    })),
  })),
})

// 每种上下文只有一格不一样：主场圈正式词条的公开这一格有权限，权限随上下文变
const matrix: KeyAccessMatrix = {
  contexts: ACCESS_CONTEXTS.map((context, i) => ({
    context,
    originScope: (['any', 'client', 'direct', 'group', 'client'] as const)[i]!,
    credentials: context === 'none' ? ('use' as const) : ('none' as const),
    circles: [circleMatrix(i)],
  })),
}
const expected = ['读写', '仅按短 ID 读取', '读写', '仅按短 ID 读取', '仅写入']

function render(context: (typeof ACCESS_CONTEXTS)[number], key = keyInfo()) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(keyMatrixKey(CIRCLE, CLIENT, key), matrix)
  const app = createSSRApp(KeyMatrix, {
    circleId: CIRCLE,
    clientId: CLIENT,
    keyInfo: key,
    context,
  })
  app.use(VueQueryPlugin, { queryClient })
  return renderToString(app)
}

describe('权限范围', () => {
  it('五种上下文各一根小岩芯，文字是全称', async () => {
    const html = await render('none')
    expect(html.match(/type="radio"/g)).toHaveLength(ACCESS_CONTEXTS.length)
    for (const c of ACCESS_CONTEXTS) {
      expect(html).toContain(`aria-label="${accessContextLabels[c]}的权限范围"`)
    }
  })

  it('每根小岩芯画的是自己那种上下文的权限，不是当前选中的那份', async () => {
    const html = await render('none')
    const blocks = html.split('<label').slice(1)
    expect(blocks).toHaveLength(ACCESS_CONTEXTS.length)
    const fill = (i: number, color: string) => blocks[i]!.includes(`fill:${color}`)
    // 能读能写是满色，只能按短 ID 读取是实心，只写只有下沿的条
    expect(fill(0, 'var(--access-primary)')).toBe(true)
    expect(fill(1, 'var(--strata-explicit)')).toBe(true)
    expect(fill(1, 'var(--access-primary)')).toBe(false)
    expect(fill(2, 'var(--access-primary)')).toBe(true)
    expect(fill(3, 'var(--strata-explicit)')).toBe(true)
    expect(fill(4, 'var(--strata-explicit)')).toBe(false)
    expect(fill(4, 'var(--access-primary)')).toBe(true)
  })

  it('切到哪种上下文，矩阵就是接口给的那一份，来源范围也跟着变', async () => {
    const title = `${entryKindLabels.entry} ${sensitivityLabels.public}`
    for (const [i, c] of ACCESS_CONTEXTS.entries()) {
      const html = await render(c)
      expect(html, c).toContain(`title="${title}：${expected[i]}"`)
      expect(html, c).toContain(originScopeLabels[matrix.contexts[i]!.originScope])
      expect(html.match(/class="[^"]*\bon\b[^"]*ctx|class="ctx on"/g), c).toHaveLength(1)
      expect(html.match(/checked/g), c).toHaveLength(1)
    }
  })

  it('当前有效范围比签发范围小时说明，一样时不说', async () => {
    expect(await render('none')).not.toContain('已按所有者当前角色收紧')
    const narrowed = keyInfo({
      effectiveScopes: {
        readKinds: [...ENTRY_KINDS],
        writeKinds: [],
        maxSensitivity: 'private',
        allowedRealms: null,
        admin: false,
        credentials: 'none' as const,
      },
    })
    expect(await render('none', narrowed)).toContain('已按所有者当前角色收紧')
  })
})
