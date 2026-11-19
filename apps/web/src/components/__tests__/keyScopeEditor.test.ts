import {
  ENTRY_KINDS,
  SENSITIVITIES,
  sensitivityAllowed,
  type CircleKind,
  type LensKeyScopes,
} from '@kioku/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

import { entryKindLabels } from '../../labels'
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
  accessKindShortLabels,
  issuedScopeRows,
  kindAccessKind,
  orderKindRows,
} from '../strata/strata'

vi.mock('../Hint.vue', () => ({ default: defineComponent({ render: () => h('i') }) }))

const blank = () => h('i')

async function render(
  scopes: LensKeyScopes,
  preset: string,
  isCircleOwner = true,
  circleKind: CircleKind = 'shared',
) {
  const app = createSSRApp({
    render: () =>
      h(KeyScopeEditor, {
        scopes,
        preset,
        isCircleOwner,
        circleKind,
        realmTerms: [{ slug: 'work', label: '工作' }],
      }),
  })
  app.component('USwitch', blank)
  app.component('UIcon', blank)
  app.component('UInput', blank)
  app.component('UButton', blank)
  return renderToString(app)
}

const of = (id: string) => keyPresets.find((p) => p.id === id)!
const scopesOf = (id: string, owner = true) => presetScopes(of(id), owner)

describe('模板匹配', () => {
  it('和模板完全一样时选中它，物种与场域元素的先后不算', () => {
    for (const preset of keyPresets) {
      expect(matchPreset(scopesOf(preset.id), true)).toBe(preset.id)
      const reversed = { ...scopesOf(preset.id) }
      reversed.readKinds = [...reversed.readKinds].reverse()
      expect(matchPreset(reversed, true)).toBe(preset.id)
    }
  })

  it('改了任何一项就是自定义', () => {
    const agent = scopesOf('agent')
    expect(matchPreset({ ...agent, maxSensitivity: 'internal' }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, credentials: 'manage' }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, admin: true }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, allowedRealms: ['work'] }, true)).toBe(CUSTOM_PRESET)
    expect(matchPreset({ ...agent, writeKinds: ['entry'] }, true)).toBe(CUSTOM_PRESET)
  })

  it('改回去又对上模板：只读加上全部写入就是本机编码 Agent 的权限', () => {
    const ro = scopesOf('readonly')
    const back = { ...ro, writeKinds: [...ENTRY_KINDS], credentials: 'use' as const }
    expect(matchPreset(back, true)).toBe('agent')
  })

  it('不是记忆圈所有者时模板先按签发人收紧再比：凭据能力只能是不可用', () => {
    expect(scopesOf('agent', false).credentials).toBe('none')
    expect(scopesOf('agent', true).credentials).toBe('use')
    expect(matchPreset(scopesOf('agent', false), false)).toBe('agent')
    expect(matchPreset(scopesOf('agent', false), true)).toBe(CUSTOM_PRESET)
  })

  it('模板的权限是新数组，改表格不会改到模板本身', () => {
    const copy = scopesOf('agent')
    copy.readKinds.pop()
    expect(of('agent').scopes.readKinds).toEqual([...ENTRY_KINDS])
  })
})

describe('签发弹窗的权限表', () => {
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
      const expected = orderKindRows(issuedScopeRows(scopes, 'shared')).flatMap((row) =>
        SENSITIVITIES.map((s) => {
          const cell = row.cells.find((c) => c.sensitivity === s)!
          const kind = kindAccessKind(row.kind, cell)
          return {
            kind,
            text: sensitivityAllowed('shared', row.kind, s)
              ? accessKindShortLabels[kind]
              : '不适用',
          }
        }),
      )
      expect(cellTexts(html)).toEqual(expected)
    },
  )

  it('行按物种顺序排列，读写勾选框有读屏名称', async () => {
    const html = await render(scopesOf('bot'), 'bot')
    const names = [
      ...html.matchAll(/<th scope="row"[\s\S]*?<span(?: data-v-\w+)?>([^<]+)<\/span>/g),
    ].map((m) => m[1])
    expect(names).toEqual(
      ['episode', 'fact', 'entry'].map((k) => entryKindLabels[k as keyof typeof entryKindLabels]),
    )
    for (const k of ENTRY_KINDS) {
      expect(html).toContain(`aria-label="读 ${entryKindLabels[k]}"`)
      expect(html).toContain(`aria-label="写 ${entryKindLabels[k]}"`)
    }
    expect(html).not.toMatch(/aria-label="写 词条" checked/)
    expect(html).toMatch(/aria-label="读 词条" checked/)
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

  it('不是记忆圈所有者：机密、取用、管理与管理词表及人格权限禁用，并写出原因', async () => {
    const html = await render(scopesOf('agent', false), 'agent', false)
    expect(html).toContain('仅记忆圈所有者可签发机密级')
    expect(html).toContain('仅记忆圈所有者的接入实例可以取用或管理凭据。')
    expect(html).toContain('仅记忆圈所有者可开启')
    expect(html).toMatch(/value="secret" disabled/)
    expect(html).toMatch(/value="use" disabled/)
    expect(html).toMatch(/value="manage" disabled/)
    expect(html).not.toMatch(/value="none" disabled/)
  })

  it('静态场域白名单可限定到具体场域词条', async () => {
    const html = await render({ ...scopesOf('agent'), allowedRealms: ['work'] }, CUSTOM_PRESET)
    expect(html).toContain('允许的场域')
    expect(html).toContain('工作')
  })

  it('实际凭据能力不足时提示实际值', async () => {
    const scopes = { ...scopesOf('agent'), credentials: 'manage' as const, writeKinds: [] }
    expect(issuedCredentialCapability(scopes)).toBe('use')
    const html = await render(scopes, CUSTOM_PRESET)
    expect(html).toContain('按当前签发范围，凭据能力实际为「取用」')
    const none = { ...scopesOf('agent'), maxSensitivity: 'internal' as const }
    expect(await render(none, CUSTOM_PRESET)).toContain('凭据能力实际为「不可用」')
    expect(await render(scopesOf('agent'), 'agent')).not.toContain('凭据能力实际为')
  })

  it('在勾选框与单选上按回车不签发：输入不属于任何表单', async () => {
    const html = await render(scopesOf('agent'), 'agent')
    const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0])
    expect(inputs.filter((i) => /type="checkbox"/.test(i))).toHaveLength(ENTRY_KINDS.length * 2)
    expect(inputs.filter((i) => /type="radio"/.test(i)).length).toBeGreaterThan(0)
    for (const input of inputs) expect(input).not.toMatch(/\sform=/)
    expect(html).not.toContain('<form')
    expect(keyScopeEditorSource).not.toMatch(/<form|@submit/)
  })

  it('格子的判断只用共享的规则，不另写一份', () => {
    expect(keyScopeEditorSource).toContain('issuedScopeRows(scopes.value, props.circleKind)')
    expect(keyScopeEditorSource).toContain('kindAccessKind(row.kind, cell)')
    expect(keyScopeEditorSource).toContain('paintAccess(')
    expect(keyScopeEditorSource).toContain('matchPreset(next, props.isCircleOwner)')
    expect(keyScopeEditorSource).toContain(
      'disabled: allowedCredentialCapability(c, props.isCircleOwner) !== c',
    )
  })
})
