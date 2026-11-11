import type { AppInfo, SpaceSummary } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import { ApiError } from '../api/client'
import endpoints from '../api/endpoints?raw'
import {
  GRANT_GONE,
  NEW_APP,
  appSlugProblem,
  approveBody,
  defaultAppSlug,
  defaultGrantPreset,
  defaultGrantScopes,
  defaultKeyName,
  defaultSpaceId,
  displayUserCode,
  grantApps,
  grantFailure,
  isGrantExpired,
  issuableSpaces,
  lookupFailure,
  nameProblem,
  normalizeUserCode,
} from '../authorize'
import appKeys from '../components/AppKeys.vue?raw'
import { issuedCredentialCapability, tightenScopes } from '../components/keyPresets'
import authorizePage from '../pages/AuthorizePage.vue?raw'
import { routes } from '../routes'
import routesSource from '../routes?raw'

// 没有组件测试的环境：判断放在 authorize.ts 里直接测，页面看源码本身

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: {
    name: string
    arg?: { content: string }
    value?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const root = parse(authorizePage).descriptor.template!.ast as unknown as TemplateNode
const walk = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(walk),
]
const elements = walk(root)
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const textOf = (el: TemplateNode): string =>
  (el.children ?? [])
    .map((c) => (c as unknown as { content?: unknown }).content)
    .filter((c) => typeof c === 'string')
    .join('')
    .trim()
const button = (label: string) =>
  elements.find((el) => el.tag === 'UButton' && textOf(el) === label)!
// 一个元素上面的各级元素
const ancestors = (target: TemplateNode): TemplateNode[] => {
  const path = (node: TemplateNode, trail: TemplateNode[]): TemplateNode[] | null => {
    if (node === target) return trail
    for (const child of node.children ?? []) {
      const found = path(child, node.type === ELEMENT ? [...trail, node] : trail)
      if (found) return found
    }
    return null
  }
  return path(root, []) ?? []
}

const space = (id: string, role: SpaceSummary['role']): SpaceSummary => ({ id, name: id, role })
const app = (over: Partial<AppInfo>): AppInfo =>
  ({
    id: 'a',
    slug: 'codex',
    name: 'Codex',
    runtimeFamily: 'codex',
    ownerAccountId: 'me',
    defaultPersonaId: null,
    config: {},
    ...over,
  }) as AppInfo

describe('确认码', () => {
  it('小写、空格与连字符都规整成 8 个大写字母', () => {
    expect(normalizeUserCode('bcdf-ghjk')).toBe('BCDFGHJK')
    expect(normalizeUserCode('  bcdf ghjk ')).toBe('BCDFGHJK')
    expect(normalizeUserCode('B-C-D-F G H J K')).toBe('BCDFGHJK')
    expect(displayUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
  })

  it('长度不对、带确认码不用的字母时不发请求', () => {
    expect(normalizeUserCode('')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJ')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJKL')).toBeNull()
    // 元音与数字不在确认码的字母里
    expect(normalizeUserCode('ABCD-EFGH')).toBeNull()
    expect(normalizeUserCode('BCDF-GH12')).toBeNull()
  })

  it('不从地址读：页面不碰地址参数，路由里也不带', () => {
    const script = parse(authorizePage).descriptor.scriptSetup!.content
    expect(script).not.toMatch(/route\.query|route\.params|location\.|URLSearchParams/)
    // 回登录页时只带路径
    expect(script).toContain('next: route.path')
    expect(script).not.toContain('fullPath')
    const record = routes.find((r) => r.name === 'authorize')!
    expect(record.path).toBe('/authorize')
    // 接口把确认码放在请求体里
    expect(endpoints).toContain("request('POST', '/device/grants/lookup', { body: { userCode }")
    expect(endpoints).toContain("request('POST', '/device/grants/deny', { body: { userCode } })")
  })

  it('输入框等宽、大写，不让浏览器记住或改写', () => {
    const input = elements.find((el) => attr(el, 'placeholder') === 'XXXX-XXXX')!
    expect(bound(input, 'ui')).toContain('font-mono uppercase')
    expect(attr(input, 'autocomplete')).toBe('off')
    expect(attr(input, 'spellcheck')).toBe('false')
  })
})

describe('路由', () => {
  it('确认页要登录：不在跳过登录检查的页面里，也不在外壳里', () => {
    expect(routes.find((r) => r.path === '/')!.children!.some((r) => r.name === 'authorize')).toBe(
      false,
    )
    // 守卫里跳过登录检查的只有设置密码链接
    expect(routesSource).toContain("if (to.name === 'password') return true")
    expect(routesSource).not.toMatch(/to\.name === 'authorize'/)
  })
})

describe('确认这一步', () => {
  it('确认与拒绝不在表单里，也不是提交按钮：回车不会确认', () => {
    for (const label of ['确认', '拒绝']) {
      const el = button(label)
      expect(attr(el, 'type')).toBeUndefined()
      expect(ancestors(el).some((a) => a.tag === 'form')).toBe(false)
    }
    expect(handler(button('确认'), 'click')).toBe('approve')
    expect(handler(button('拒绝'), 'click')).toBe('deny')
    // 整个确认这一步里没有表单：权限编辑器的单选与勾选框不会隐式提交
    const editor = elements.find((el) => el.tag === 'KeyScopeEditor')!
    expect(ancestors(editor).some((a) => a.tag === 'form')).toBe(false)
    // 页面上唯一的表单是第一步的查看申请
    const forms = elements.filter((el) => el.tag === 'form')
    expect(forms).toHaveLength(1)
    expect(handler(forms[0]!, 'submit')).toBe('lookup')
  })

  it('权限范围用签发访问密钥的那个编辑器，收紧规则和签发弹窗是同一个函数', () => {
    const editor = elements.find((el) => el.tag === 'KeyScopeEditor')!
    expect(bound(editor, 'is-space-owner')).toBe('isSpaceOwner')
    expect(elements.some((el) => el.tag === 'table')).toBe(false)
    expect(authorizePage).toContain('tightenScopes(form.scopes, owner)')
    expect(appKeys).toContain('tightenScopes(form.scopes, owner)')
  })

  it('申请的事实是属性列表，自报的名字只当文本显示', () => {
    expect(elements.some((el) => el.tag === 'PropertyList')).toBe(true)
    expect(elements.some((el) => el.props?.some((p) => p.name === 'html'))).toBe(false)
    expect(authorizePage).toContain('命令行自报，未经核实')
  })

  it('页面不显示访问密钥', () => {
    expect(authorizePage).not.toMatch(/\.key\b/)
    expect(authorizePage).toContain('访问密钥由命令行取走，这里不显示')
  })
})

describe('空间与应用', () => {
  const spaces = [space('viewer', 'viewer'), space('editor', 'editor'), space('owner', 'owner')]

  it('只列当前账号是所有者或编辑者的空间', () => {
    expect(issuableSpaces(spaces).map((s) => s.id)).toEqual(['editor', 'owner'])
    expect(issuableSpaces([space('viewer', 'viewer')])).toEqual([])
  })

  it('默认是最近访问的空间，它不能签发时取第一个能签发的', () => {
    expect(defaultSpaceId(spaces, 'owner')).toBe('owner')
    expect(defaultSpaceId(spaces, 'viewer')).toBe('editor')
    expect(defaultSpaceId(spaces, null)).toBe('editor')
    expect(defaultSpaceId([space('viewer', 'viewer')], 'viewer')).toBeNull()
  })

  it('只列自己是所有者、运行时一致的应用', () => {
    const list = [
      app({ id: 'mine' }),
      app({ id: 'others', ownerAccountId: 'someone' }),
      app({ id: 'claude', runtimeFamily: 'claudecode' }),
    ]
    expect(grantApps(list, 'me', 'codex').map((a) => a.id)).toEqual(['mine'])
    expect(grantApps(list, undefined, 'codex')).toEqual([])
  })

  it('新应用的默认标识避开已有的', () => {
    expect(defaultAppSlug('codex', [])).toBe('codex')
    expect(defaultAppSlug('codex', ['codex'])).toBe('codex-2')
    expect(defaultAppSlug('codex', ['codex', 'codex-2'])).toBe('codex-3')
  })

  it('标识照契约校验，已有的不能再用', () => {
    expect(appSlugProblem('codex', [])).toBeNull()
    expect(appSlugProblem('Codex', [])).not.toBeNull()
    expect(appSlugProblem('-codex', [])).not.toBeNull()
    expect(appSlugProblem('', [])).not.toBeNull()
    expect(appSlugProblem('codex', ['codex'])).toContain('已被占用')
  })

  it('访问密钥的默认名称：自报的名字，没有就用运行时的名字', () => {
    expect(defaultKeyName({ clientName: 'laptop', runtimeFamily: 'codex' })).toBe('laptop')
    expect(defaultKeyName({ clientName: null, runtimeFamily: 'codex' })).toBe('Codex')
    expect(nameProblem('  ')).not.toBeNull()
    expect(nameProblem('a'.repeat(65))).not.toBeNull()
    expect(nameProblem('😀'.repeat(64))).toBeNull()
  })

  it('请求体：已有的应用带 id，新建的带标识与名称', () => {
    const base = {
      userCode: 'BCDFGHJK',
      spaceId: 's',
      newApp: { slug: 'codex', name: ' Codex ' },
      keyName: ' laptop ',
      scopes: defaultGrantScopes(false),
    }
    expect(approveBody({ ...base, appChoice: 'app-id' }).app).toEqual({ id: 'app-id' })
    const created = approveBody({ ...base, appChoice: NEW_APP })
    expect(created.app).toEqual({ slug: 'codex', name: 'Codex' })
    expect(created.keyName).toBe('laptop')
  })
})

describe('默认的签发范围', () => {
  it('不含凭据能力、机密级与跨人格写入，所有者也一样', () => {
    for (const owner of [true, false]) {
      const scopes = defaultGrantScopes(owner)
      expect(scopes.credentials).toBe('none')
      expect(issuedCredentialCapability(scopes)).toBe('none')
      expect(scopes.maxSensitivity).toBe('private')
      expect(scopes.admin).toBe(false)
    }
    // 编辑者的默认值正好是收紧后的「本机编码 Agent」，所有者的比模板少了凭据，算自定义
    expect(defaultGrantPreset(false)).toBe('agent')
    expect(defaultGrantPreset(true)).toBe('custom')
  })

  it('换到不是所有者的空间时收紧', () => {
    const wide = { ...defaultGrantScopes(true), credentials: 'manage', admin: true } as const
    const tightened = tightenScopes({ ...wide, maxSensitivity: 'secret' }, false)
    expect(tightened).toMatchObject({
      credentials: 'none',
      admin: false,
      maxSensitivity: 'private',
    })
    expect(tightenScopes({ ...wide, maxSensitivity: 'secret' }, true)).toMatchObject({
      credentials: 'manage',
      admin: true,
      maxSensitivity: 'secret',
    })
  })
})

describe('失败的处理', () => {
  it('404：确认码不对或已过期，回第一步', () => {
    expect(grantFailure(new ApiError(404, GRANT_GONE), '确认失败')).toEqual({
      kind: 'gone',
      text: GRANT_GONE,
    })
    expect(lookupFailure(new ApiError(404, '随便什么'))).toBe(GRANT_GONE)
    // 拒绝遇到 404 直接回第一步；确认遇到 404 先按确认码再查一次（也可能是应用不存在）
    const script = parse(authorizePage).descriptor.scriptSetup!.content
    expect(script).toContain("if (failure.kind === 'gone') restart(GRANT_GONE)")
    expect(script).toContain('restart(lookupFailure(again))')
  })

  it('403：留在这一步，显示服务端给的文字', () => {
    expect(grantFailure(new ApiError(403, '需要空间所有者或编辑者角色'), '确认失败')).toEqual({
      kind: 'message',
      text: '需要空间所有者或编辑者角色',
    })
  })

  it('409：标识被占用，写在标识那一栏', () => {
    expect(grantFailure(new ApiError(409, '标识 codex 已被占用'), '确认失败')).toEqual({
      kind: 'slug',
      text: '标识 codex 已被占用',
    })
  })

  it('不是接口给的错误（断网、响应对不上契约）用固定的说法', () => {
    expect(grantFailure(new TypeError('x'), '确认失败')).toEqual({
      kind: 'message',
      text: '确认失败',
    })
    expect(lookupFailure(new TypeError('x'))).toBe('申请读取失败')
  })

  it('到期之后不能确认', () => {
    const info = { expiresAt: '2026-11-11T00:10:00.000Z' }
    expect(isGrantExpired(info, new Date('2026-11-11T00:09:59.000Z'))).toBe(false)
    expect(isGrantExpired(info, new Date('2026-11-11T00:10:00.000Z'))).toBe(true)
    expect(authorizePage).toContain('!expired.value &&')
  })
})
