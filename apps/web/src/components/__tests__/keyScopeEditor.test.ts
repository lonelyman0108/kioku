import { LAYERS, SENSITIVITIES, sensitivityAllowed, type KeyScopes } from '@kioku/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { layerLabels } from '../../labels'
import {
  CUSTOM_PRESET,
  issuedCredentialCapability,
  keyPresets,
  matchPreset,
  presetScopes,
} from '../keyPresets'
import KeyScopeEditor from '../KeyScopeEditor.vue'
import keyScopeEditorSource from '../KeyScopeEditor.vue?raw'
import {
  accessKind,
  accessKindShortLabels,
  issuedScopeRows,
  orderRows,
  STACK,
} from '../strata/strata'

// 提示层与开关依赖组件库的 provider，这里只看卡片与表格本身
vi.mock('../Hint.vue', () => ({ default: defineComponent({ render: () => h('i') }) }))

// 组件库的开关与图标换成空的函数组件
const blank = () => h('i')

async function render(scopes: KeyScopes, preset: string, isSpaceOwner = true) {
  const app = createSSRApp({
    render: () => h(KeyScopeEditor, { scopes, preset, isSpaceOwner }),
  })
  app.component('USwitch', blank)
  app.component('UIcon', blank)
  return renderToString(app)
}

const of = (id: string) => keyPresets.find((p) => p.id === id)!
const scopesOf = (id: string, owner = true) => presetScopes(of(id), owner)

describe('模板匹配', () => {
  it('和模板完全一样时选中它，归属的先后不算', () => {
    for (const preset of keyPresets) {
      expect(matchPreset(scopesOf(preset.id), true)).toBe(preset.id)
      const reversed = { ...scopesOf(preset.id) }
      reversed.readLayers = [...reversed.readLayers].reverse()
      expect(matchPreset(reversed, true)).toBe(preset.id)
    }
  })

  it('改了任何一项就是自定义', () => {
    const agent = scopesOf('agent')
    expect(matchPreset({ ...agent, maxSensitivity: 'internal' }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, credentials: 'manage' }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, admin: true }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, writeLayers: ['core'] }, true)).toBe(CUSTOM_PRESET)
  })

  it('改回去又对上模板：只读加上全部写入就是本机编码 Agent 的归属', () => {
    const ro = scopesOf('readonly')
    const back = { ...ro, writeLayers: [...LAYERS], credentials: 'use' as const }
    expect(matchPreset(back, true)).toBe('agent')
  })

  it('不是空间所有者时模板先按签发人收紧再比：凭据能力只能是不可用', () => {
    expect(scopesOf('agent', false).credentials).toBe('none')
    expect(scopesOf('agent', true).credentials).toBe('use')
    expect(matchPreset(scopesOf('agent', false), false)).toBe('agent')
    // 所有者眼里收紧过的那份已经不是本机编码 Agent 了
    expect(matchPreset(scopesOf('agent', false), true)).toBe(CUSTOM_PRESET)
  })

  it('模板的权限是新数组，改表格不会改到模板本身', () => {
    const copy = scopesOf('agent')
    copy.readLayers.pop()
    expect(of('agent').scopes.readLayers).toEqual([...LAYERS])
  })
})

describe('签发弹窗的权限表', () => {
  // 按渲染出来的顺序取每一格的种类与短文字：表格自上而下按 STACK，每行四个敏感级
  const classes = (attr: string) => attr.split(/\s+/)
  const cellTexts = (html: string) =>
    [...html.matchAll(/<td class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)]
      .filter((m) => classes(m[1]!).includes('c'))
      .map((m) => {
        const label = /class="c-(?:label|none|na)"[^>]*>([^<]*)</.exec(m[2]!)
        const kind = classes(m[1]!).find((c) => !['c', 'edge', 'na'].includes(c))!
        return { kind, text: label?.[1]?.trim() ?? '' }
      })

  it.each(keyPresets.map((p) => [p.label, p.id]))(
    '%s：每一格和 issuedScopeRows 换算的一样',
    async (_label, id) => {
      const scopes = scopesOf(id)
      const html = await render(scopes, id)
      const expected = orderRows(issuedScopeRows(scopes)).flatMap((row) =>
        SENSITIVITIES.map((s) => {
          const cell = row.cells.find((c) => c.sensitivity === s)!
          const kind = accessKind(row.layer, cell)
          return {
            kind,
            text: sensitivityAllowed(row.layer, s) ? accessKindShortLabels[kind] : '不适用',
          }
        }),
      )
      expect(cellTexts(html)).toEqual(expected)
    },
  )

  it('行按 STACK，读写勾选框有读屏名称', async () => {
    const html = await render(scopesOf('bot'), 'bot')
    const names = [
      ...html.matchAll(/<th scope="row"[\s\S]*?<span(?: data-v-\w+)?>([^<]+)<\/span>/g),
    ].map((m) => m[1])
    expect(names).toEqual(STACK.map((l) => layerLabels[l]))
    for (const l of LAYERS) {
      expect(html).toContain(`aria-label="读 ${layerLabels[l]}"`)
      expect(html).toContain(`aria-label="写 ${layerLabels[l]}"`)
    }
    // 群聊机器人不读本人
    expect(html).not.toMatch(/aria-label="读 本人" checked/)
    expect(html).toMatch(/aria-label="读 通用" checked/)
  })

  it('边界线画在最高敏感级那一列', async () => {
    const html = await render(scopesOf('bot'), 'bot')
    const heads = [...html.matchAll(/<th scope="col" class="([^"]*col-sens[^"]*)"/g)].map((m) =>
      classes(m[1]!).includes('edge'),
    )
    expect(heads).toEqual([true, false, false, false])
  })

  it('选中的卡片和模板一一对应，自定义没有标签', async () => {
    const html = await render(scopesOf('readonly'), 'readonly')
    expect(html.match(/class="(?:tpl on|on tpl)"/g)).toHaveLength(1)
    expect(html).toMatch(/value="readonly" checked/)
    expect(html.match(/class="scope-tags tpl-tags"/g)).toHaveLength(keyPresets.length)
  })

  it('不是空间所有者：机密、取用、管理与跨人格写入禁用，并写出原因', async () => {
    const html = await render(scopesOf('agent', false), 'agent', false)
    expect(html).toContain('仅空间所有者可签发机密级')
    expect(html).toContain('仅空间所有者的应用可以取用或管理凭据。')
    expect(html).toContain('仅空间所有者可开启')
    expect(html).toMatch(/value="secret" disabled/)
    expect(html).toMatch(/value="use" disabled/)
    expect(html).toMatch(/value="manage" disabled/)
    expect(html).not.toMatch(/value="none" disabled/)
  })

  it('实际凭据能力不足时提示实际值', async () => {
    const scopes = { ...scopesOf('agent'), credentials: 'manage' as const, writeLayers: [] }
    expect(issuedCredentialCapability(scopes)).toBe('use')
    const html = await render(scopes, CUSTOM_PRESET)
    expect(html).toContain('按当前签发范围，凭据能力实际为「取用」')
    const none = { ...scopesOf('agent'), maxSensitivity: 'internal' as const }
    expect(await render(none, CUSTOM_PRESET)).toContain('凭据能力实际为「不可用」')
    expect(await render(scopesOf('agent'), 'agent')).not.toContain('凭据能力实际为')
  })

  // 在勾选框、单选上按回车，只有它们属于某个表单时才会隐式提交。编辑器自己不带表单，
  // 每个输入也不借 form 属性挂到别处的表单上；签发弹窗不用表单见 accessPages.test.ts
  it('在勾选框与单选上按回车不签发：输入不属于任何表单，也不接回车', async () => {
    const html = await render(scopesOf('agent'), 'agent')
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
    expect(inputs.filter((i) => /type="checkbox"/.test(i))).toHaveLength(LAYERS.length * 2)
    expect(inputs.filter((i) => /type="radio"/.test(i)).length).toBeGreaterThan(0)
    for (const input of inputs) expect(input).not.toMatch(/\sform=/)
    expect(html).not.toContain('<form')
    expect(keyScopeEditorSource).not.toMatch(/<form|@submit|@key(down|up|press)\.enter/)
  })

  it('格子的判断只用共享的规则，不另写一份', () => {
    expect(keyScopeEditorSource).toContain('issuedScopeRows(scopes.value)')
    expect(keyScopeEditorSource).toContain('accessKind(row.layer, cell)')
    expect(keyScopeEditorSource).toContain('paintAccess(')
    expect(keyScopeEditorSource).toContain('matchPreset(next, props.isSpaceOwner)')
    expect(keyScopeEditorSource).toContain(
      'disabled: allowedCredentialCapability(c, props.isSpaceOwner) !== c',
    )
  })
})
