import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import consoleLayout from '../layouts/ConsoleLayout.vue?raw'

// 没有组件测试的环境，所以看源码本身：外壳改过长相，这些逻辑不能跟着丢
const { descriptor } = parse(consoleLayout)
const script = descriptor.scriptSetup?.content ?? ''
const template = descriptor.template?.content ?? ''

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
const walk = (node: TemplateNode): TemplateNode[] => [node, ...(node.children ?? []).flatMap(walk)]
const elements = walk(descriptor.template!.ast as unknown as TemplateNode).filter(
  (n) => n.type === ELEMENT,
)
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const labelled = (label: string) => elements.find((el) => attr(el, 'aria-label') === label)!
const classes = (el: TemplateNode) => (attr(el, 'class') ?? '').split(/\s+/)

describe('顶部导航', () => {
  it('按用途分组，入口的名字按术语表', () => {
    const labels = [...script.matchAll(/\{ label: '([^']+)', \.\.\.link\(/g)].map((m) => m[1])
    expect(labels).toEqual([
      '概览',
      '记忆',
      '待处理',
      '人格',
      '联系人',
      '凭据',
      '应用',
      '召回',
      '测试台',
      '变更记录',
      '设置',
    ])
    expect([...script.matchAll(/title: '([^']+)'/g)].map((m) => m[1])).toEqual([
      '知识',
      '接入',
      '空间',
    ])
  })

  it('详情页点亮列表的入口', () => {
    expect(script).toContain("link('subjects', icons.subjects, ['subjects', 'subject'])")
    expect(script).toContain("link('apps', icons.apps, ['apps', 'app'])")
  })

  it('实例设置只给管理员，放在账号菜单里', () => {
    expect(script).toMatch(/me\.data\.value\?\.isAdmin\s*\? \[\{ label: '实例设置'/)
    expect(script).toContain('...(instanceNav.value.length')
    expect(script).not.toMatch(/\{ label: '实例设置', \.\.\.link\(/)
  })

  it('窄屏把导航收进抽屉，宽屏和窄屏的分界一致', () => {
    const names = elements.find((el) => el.children?.some((c) => c.tag === 'UDropdownMenu'))!
    expect(template).toContain('<USlideover')
    expect(classes(labelled('主导航'))).toContain('max-[1024px]:hidden')
    expect(classes(names)).toContain('max-[1024px]:hidden')
    expect(classes(labelled('打开导航'))).toContain('min-[1024px]:hidden')
    expect(bound(labelled('搜索'), 'ui')).toContain('min-[1024px]:flex')
    expect(template).not.toContain('901px')
  })
})

describe('顶栏放不下时', () => {
  it('导航和搜索不缩，由名字那一段让出位置，账号菜单一直在屏幕里', () => {
    expect(classes(labelled('主导航'))).toContain('shrink-0')
    expect(classes(labelled('搜索'))).toContain('shrink-0')
    const right = elements.find((el) =>
      el.children?.some((c) => c.tag === 'UDashboardSearchButton'),
    )!
    expect(classes(right)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'justify-end']))
  })

  it('空间名、显示名能截断，悬停看全名', () => {
    for (const [label, name] of [
      ['切换空间', 'space?.name'],
      ['账号菜单', 'displayName'],
    ] as const) {
      const button = labelled(label)
      expect(classes(button), label).toEqual(expect.arrayContaining(['min-w-0', 'max-w-48']))
      expect(bound(button, 'title'), label).toBe(name)
    }
    const single = elements.find((el) => el.tag === 'span' && bound(el, 'title') === 'space.name')!
    expect(classes(single)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
  })

  it('菜单和抽屉里的长名字也不撑破', () => {
    const menus = elements.filter((el) => el.tag === 'UDropdownMenu')
    expect(menus).toHaveLength(2)
    for (const menu of menus) expect(bound(menu, 'ui')).toContain('max-w-80')
    const inDrawer = walk(elements.find((el) => el.tag === 'USlideover')!)
    for (const name of ['s.name', 'displayName']) {
      const el = inDrawer.find((n) => bound(n, 'title') === name)!
      expect(classes(el), name).toContain('truncate')
    }
  })
})

describe('抽屉', () => {
  const slideover = elements.find((el) => el.tag === 'USlideover')!

  it('菜单按钮是默认插槽里的 trigger：这样才有 aria-expanded，关上后焦点回到它', () => {
    const trigger = slideover.children?.find((c) => c.tag !== 'template')
    expect(trigger?.tag).toBe('UButton')
    expect(attr(trigger!, 'aria-label')).toBe('打开导航')
    expect(trigger!.props?.some((p) => p.name === 'on')).toBe(false)
    expect(template).not.toMatch(/navOpen = true/)
    expect(script).not.toMatch(/navOpen\.value = true/)
  })

  it('窗口变宽跨过分界就关上，分界和模板一致，焦点放到还看得见的账号菜单上', () => {
    expect(script).toContain("window.matchMedia('(min-width: 1024px)')")
    expect(script).toContain('if (event.matches) navOpen.value = false')
    expect(script).toContain("wideScreen.addEventListener('change', closeNavOnWideScreen)")
    expect(script).toContain("wideScreen.removeEventListener('change', closeNavOnWideScreen)")
    expect(bound(slideover, 'content')).toContain('onCloseAutoFocus: focusAfterNavClosed')
    expect(attr(labelled('账号菜单'), 'ref')).toBe('accountButton')
    const focus = /function focusAfterNavClosed\(event: Event\) \{[^}]*\}/.exec(script)![0]
    expect(focus).toContain('if (!wideScreen.matches) return')
    expect(focus).toContain('accountButton.value?.$el.focus()')
  })

  it('切换空间时关上抽屉，点当前空间地址不变也要关', () => {
    const body = /function switchSpace\(id: string\) \{[^}]*\}/.exec(script)![0]
    expect(body).toContain('navOpen.value = false')
    const spaceButton = walk(slideover).find((n) => bound(n, 'title') === 's.name')!
    expect(spaceButton.props?.find((p) => p.name === 'on')?.exp?.content).toBe('switchSpace(s.id)')
  })
})

describe('保留的逻辑', () => {
  it('会话过期带人回登录页，登录后回到原来的页面', () => {
    expect(script).toContain("router.replace({ name: 'login', query: { next: route.fullPath } })")
  })

  it('退出前确认未保存的修改，退出后清掉缓存', () => {
    const logout = script.slice(script.indexOf('async function logout'))
    expect(logout.indexOf('confirmDiscard()')).toBeLessThan(logout.indexOf('api.logout()'))
    expect(logout).toContain('queryClient.clear()')
    expect(logout).toContain('hasUnsavedChanges.value = hadUnsaved')
  })

  it('地址里的空间不是自己的时只给说明，不渲染页面', () => {
    expect(template).toContain('v-if="me.data.value && route.params.spaceId && !space"')
    expect(template).toMatch(/<RouterView v-else \/>/)
  })

  it('搜索沿用 useConsoleSearch 和 UDashboardSearch', () => {
    expect(script).toContain('useConsoleSearch(')
    expect(template).toContain('<UDashboardSearch')
    expect(template).toContain('<UDashboardSearchButton')
  })

  it('品牌区只有 KiokuMark，外壳不写死品牌字样', () => {
    expect(template).toContain('<KiokuMark')
    expect(template.replaceAll('KiokuMark', '')).not.toContain('Kioku')
  })

  it('全站的纹理定义在外壳里挂一次', () => {
    expect(template.match(/<StrataPatterns/g)).toHaveLength(1)
  })

  it('主题用 Nuxt UI 的 color mode，不另存一份', () => {
    expect(script).toContain('useColorPreference()')
    expect(script).not.toContain('localStorage')
  })
})
