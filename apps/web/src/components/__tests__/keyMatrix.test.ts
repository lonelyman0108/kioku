import {
  ACCESS_CONTEXTS,
  LAYERS,
  SENSITIVITIES,
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
  layerLabels,
  originScopeLabels,
  sensitivityLabels,
} from '../../labels'
import KeyMatrix from '../KeyMatrix.vue'

// 提示层依赖组件库的 provider，这里只看权限范围本身
vi.mock('../Hint.vue', () => ({ default: defineComponent({ render: () => h('i') }) }))

const KEY = '00000000-0000-4000-8000-000000000001'
const keyInfo = (over: Partial<KeyInfo> = {}): KeyInfo => {
  const scopes = {
    readLayers: [...LAYERS],
    writeLayers: [...LAYERS],
    maxSensitivity: 'private' as const,
    admin: false,
  }
  return {
    id: KEY,
    name: 'MacBook',
    prefix: 'kk_a',
    scopes,
    effectiveScopes: scopes,
    createdAt: '2026-10-01T00:00:00Z',
    lastUsedAt: null,
    revokedAt: null,
    ...over,
  }
}

// 每种上下文只有一格不一样：只有基础层的公开这一格有权限，权限随上下文变
const matrix: KeyAccessMatrix = {
  contexts: ACCESS_CONTEXTS.map((context, i) => ({
    context,
    originScope: (['any', 'app', 'direct', 'group', 'app'] as const)[i]!,
    rows: LAYERS.map((layer) => ({
      layer,
      cells: SENSITIVITIES.map((sensitivity) => ({
        sensitivity,
        read:
          layer === 'base' && sensitivity === 'public'
            ? (['recall', 'explicit', 'recall', 'explicit', 'none'] as const)[i]!
            : ('none' as const),
        write: layer === 'base' && sensitivity === 'public' && i % 2 === 0,
      })),
    })),
  })),
}
const expected = ['读写', '仅按 URI 读取', '读写', '仅按 URI 读取', '仅写入']

function render(context: (typeof ACCESS_CONTEXTS)[number], key = keyInfo()) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(keyMatrixKey('s1', 'a1', key), matrix)
  const app = createSSRApp(KeyMatrix, {
    spaceId: 's1',
    appId: 'a1',
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
    // 能读能写是满色，只能按 URI 读取是实心，只写只有下沿的条
    expect(fill(0, 'var(--access-base)')).toBe(true)
    expect(fill(1, 'var(--strata-explicit)')).toBe(true)
    expect(fill(1, 'var(--access-base)')).toBe(false)
    expect(fill(2, 'var(--access-base)')).toBe(true)
    expect(fill(3, 'var(--strata-explicit)')).toBe(true)
    expect(fill(4, 'var(--strata-explicit)')).toBe(false)
    expect(fill(4, 'var(--access-base)')).toBe(true)
  })

  it('切到哪种上下文，矩阵就是接口给的那一份，来源范围也跟着变', async () => {
    const title = `${layerLabels.base} ${sensitivityLabels.public}`
    for (const [i, c] of ACCESS_CONTEXTS.entries()) {
      const html = await render(c)
      expect(html, c).toContain(`title="${title}：${expected[i]}"`)
      expect(html, c).toContain(originScopeLabels[matrix.contexts[i]!.originScope])
      // 选中的只有这一个
      expect(html.match(/class="[^"]*\bon\b[^"]*ctx|class="ctx on"/g), c).toHaveLength(1)
      expect(html.match(/checked/g), c).toHaveLength(1)
    }
  })

  it('当前有效范围比签发范围小时说明，一样时不说', async () => {
    expect(await render('none')).not.toContain('已按所有者当前角色收紧')
    const narrowed = keyInfo({
      effectiveScopes: {
        readLayers: [...LAYERS],
        writeLayers: [],
        maxSensitivity: 'private',
        admin: false,
      },
    })
    expect(await render('none', narrowed)).toContain('已按所有者当前角色收紧')
  })
})
