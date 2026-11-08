import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import { theme } from '../theme'

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
const condition = (el: TemplateNode) => el.props?.find((p) => p.name === 'if')?.exp?.content

describe('顶部导航', () => {
  it('按用途分组，入口的名字按术语表', () => {
    const labels = [...script.matchAll(/\{ label: '([^']+)', \.\.\.link\(/g)].map((m) => m[1])
    expect(labels).toEqual([
      '概览',
      '记忆',
      '对话',
      '凭据',
      '待处理',
      '应用',
      '召回',
      '测试台',
      '变更记录',
      '设置',
    ])
    expect([...script.matchAll(/title: '([^']+)'/g)].map((m) => m[1])).toEqual(['接入', '空间'])
  })

  it('详情页点亮列表的入口', () => {
    expect(script).toContain("link('conversations', icons.conversations, CONVERSATION_ROUTES)")
    expect(script).toContain("const CONVERSATION_ROUTES = ['conversations', 'contact']")
    expect(script).toContain("link('apps', icons.apps, ['apps', 'app'])")
  })

  it('每个入口都有图标，图标旁一定有文字；放不下时先收组标题、再收图标', () => {
    const link = elements.find((el) => el.tag === 'RouterLink' && bound(el, 'to') === 'item.to')!
    const icon = link.children!.find((c) => c.tag === 'UIcon')!
    expect(bound(icon, 'name')).toBe('item.icon')
    expect(classes(icon)).toContain('max-[1180px]:hidden')
    const title = elements.find((el) => el.tag === 'span' && condition(el) === 'group.title')!
    expect(classes(title)).toContain('max-[1320px]:hidden')
    expect(template).toContain('{{ item.label }}')
  })

  it('「设置」进空间组，三组设置页都点亮它', () => {
    expect(script).toContain("link('space-settings', icons.settings, SETTINGS_ROUTES)")
    expect(script).toContain(
      "const SETTINGS_ROUTES = ['space-settings', 'account-settings', 'instance-settings']",
    )
  })

  it('账号菜单：账号设置人人都有，实例设置只给管理员', () => {
    expect(script).toContain("label: '账号设置'")
    expect(script).toContain('to: accountSettingsRoute()')
    expect(script).toMatch(/me\.data\.value\?\.isAdmin\s*\? \[\s*\{\s*label: '实例设置'/)
    expect(script).toContain('to: instanceSettingsRoute()')
    expect(script).toContain('accountNav.value.map(')
    expect(script).not.toMatch(/\{ label: '实例设置', \.\.\.link\(/)
  })

  it('空间切换器一直显示：各空间与角色，当前空间打勾，下面是成员与设置；能新建空间时给新建空间', () => {
    const switcher = elements.find(
      (el) => el.tag === 'UDropdownMenu' && bound(el, 'items') === 'spaceMenu',
    )!
    expect(condition(switcher)).toBe('spaces.length || newSpace.canCreate.value')
    expect(script).toContain('role: roleName(s.role)')
    expect(script).toContain('checked: s.id === space.value?.id')
    expect(script).toContain("label: '成员与设置'")
    expect(script).not.toContain("label: '空间设置'")
    expect(script).toContain('...(newSpace.canCreate.value')
    expect(script).toContain("label: '新建空间'")
    expect(template).toContain('<CreateSpaceModal')
    expect(script).toContain('to: spaceSettingsRoute(space.value.id)')
    expect(template).toContain('#space-trailing="{ item }"')
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
    const spaceButton = walk(slideover).find(
      (n) => n.tag === 'button' && n.children?.some((c) => bound(c, 'title') === 's.name'),
    )!
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

  it('窄屏抽屉里的入口同步：图标、各空间与角色、空间设置、账号设置与实例设置', () => {
    const drawer = walk(elements.find((el) => el.tag === 'USlideover')!)
    expect(drawer.some((n) => n.tag === 'UIcon' && bound(n, 'name') === 'item.icon')).toBe(true)
    expect(
      drawer.some(
        (n) => n.tag === 'RouterLink' && bound(n, 'to') === 'spaceSettingsRoute(space.id)',
      ),
    ).toBe(true)
    const accountLinks = drawer.find(
      (n) =>
        n.tag === 'RouterLink' &&
        n.props?.some((p) => p.name === 'for' && p.exp?.content.includes('accountNav')),
    )
    expect(accountLinks).toBeDefined()
    expect(template).toContain('roleName(s.role)')
  })

  it('搜索沿用 useConsoleSearch 和 UDashboardSearch', () => {
    expect(script).toContain('useConsoleSearch(')
    expect(template).toContain('<UDashboardSearch')
    expect(template).toContain('<UDashboardSearchButton')
    // 空状态不用组件库的「没有匹配的数据」：还在搜记忆时说搜索中
    expect(template).toContain(
      `<template #empty>{{ searching ? '搜索中' : '暂无匹配' }}</template>`,
    )
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

describe('老外壳的过渡代码', () => {
  // 不在页面上用老面板：它们按组件库默认撑满视口，还带侧栏开关，放在顶部导航下面会溢出
  const vueFiles = import.meta.glob<string>('../**/*.vue', {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('页面和组件都不再用老面板', () => {
    expect(Object.keys(vueFiles).length).toBeGreaterThan(50)
    for (const [file, source] of Object.entries(vueFiles)) {
      for (const old of ['UDashboardPanel', 'UDashboardNavbar', 'UDashboardToolbar']) {
        expect(source, file).not.toContain(old)
      }
    }
  })

  it('主题里没有老面板的覆盖', () => {
    for (const key of ['dashboardPanel', 'dashboardNavbar', 'dashboardToolbar']) {
      expect(Object.keys(theme)).not.toContain(key)
    }
  })
})
