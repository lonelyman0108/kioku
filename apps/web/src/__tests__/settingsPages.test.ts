import { SetupRequest } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import appearanceSettings from '../components/AppearanceSettings.vue?raw'
import backupSettings from '../components/BackupSettings.vue?raw'
import dataSettings from '../components/DataSettings.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import embeddingChannelRow from '../components/EmbeddingChannelRow.vue?raw'
import embeddingSettings from '../components/EmbeddingSettings.vue?raw'
import extractionBudget from '../components/ExtractionBudget.vue?raw'
import extractionSettings from '../components/ExtractionSettings.vue?raw'
import loreImport from '../components/LoreImport.vue?raw'
import masterKeySettings from '../components/MasterKeySettings.vue?raw'
import modelSettings from '../components/ModelSettings.vue?raw'
import myDreamSettings from '../components/MyDreamSettings.vue?raw'
import retentionSettings from '../components/RetentionSettings.vue?raw'
import spaceExport from '../components/SpaceExport.vue?raw'
import spaceExtractionSettings from '../components/SpaceExtractionSettings.vue?raw'
import spaceImport from '../components/SpaceImport.vue?raw'
import spaceTransferSettings from '../components/SpaceTransferSettings.vue?raw'
import benchAgent from '../components/BenchAgent.vue?raw'
import EntryFrame from '../components/strata/EntryFrame.vue'
import entryFrame from '../components/strata/EntryFrame.vue?raw'
import SaveBar from '../components/strata/SaveBar.vue'
import saveBar from '../components/strata/SaveBar.vue?raw'
import SettingsBlock from '../components/strata/SettingsBlock.vue'
import SettingsFrame, { type SettingsFrameGroup } from '../components/strata/SettingsFrame.vue'
import settingsFrame from '../components/strata/SettingsFrame.vue?raw'
import SettingsRow from '../components/strata/SettingsRow.vue'
import { STACK } from '../components/strata/strata'
import homePage from '../pages/HomePage.vue?raw'
import loginPage from '../pages/LoginPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'
import settingsPage from '../pages/SettingsPage.vue?raw'
import setupPage from '../pages/SetupPage.vue?raw'
import databaseUnavailablePage from '../pages/DatabaseUnavailablePage.vue?raw'
import unavailablePage from '../pages/UnavailablePage.vue?raw'
import { routes } from '../routes'
import useSessionSource from '../composables/useSession.ts?raw'
import { fieldProblems, useSavedField } from '../composables/useSavedField'
import {
  forgetSpace,
  ME_KEY,
  pickSpace,
  rememberSpace,
  useSession,
} from '../composables/useSession'
import { queryClient as sharedClient } from '../query'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import accountSettingsPage from '../pages/AccountSettingsPage.vue?raw'
import instanceSettingsPage from '../pages/InstanceSettingsPage.vue?raw'
import spaceSettingsPage from '../pages/SpaceSettingsPage.vue?raw'
import routesSource from '../routes.ts?raw'
import settingsSectionsSource from '../settingsSections.ts?raw'
import {
  accountSettingsRoute,
  currentSection,
  instanceSettingsRoute,
  leavesSettingsPage,
  legacySettingsRedirect,
  legacySpaceSettingsRedirect,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  spaceSettingsRoute,
  visibleGroups,
  visibleSections,
} from '../settingsSections'
import { retryNavigation, retryTarget } from '../unavailable'

// 设置、登录、初始化、连接失败。长相改过，表单状态、权限、后果提示这些不能跟着丢

interface TemplateNode {
  type: number
  tag?: string
  content?: unknown
  children?: TemplateNode[]
  props?: {
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const scriptOf = (source: string) => parse(source).descriptor.scriptSetup!.content
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const directive = (el: TemplateNode, name: string) => el.props?.find((p) => p.name === name)
const condition = (el: TemplateNode) => directive(el, 'if')?.exp?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const textOf = (el: TemplateNode): string =>
  (el.children ?? [])
    .map((c) => (typeof c.content === 'string' ? c.content : ''))
    .join('')
    .trim()
// 模板里的文字折行之后再比
const flat = (source: string) => source.replace(/\s+/g, '')
// 确认框外面的按钮
function buttonsOutsideModals(node: TemplateNode): TemplateNode[] {
  if (node.tag === 'UModal') return []
  const own = node.type === ELEMENT && node.tag === 'UButton' ? [node] : []
  return [...own, ...(node.children ?? []).flatMap(buttonsOutsideModals)]
}

const render = async (
  component: Component,
  props: Record<string, unknown>,
  slots: Record<string, (...args: never[]) => unknown> = {},
  url = '/',
) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push(url)
  const app = createSSRApp({ render: () => h(component, props, slots) })
  app.use(router)
  return renderToString(app)
}

const settingsSources = {
  EmbeddingSettings: embeddingSettings,
  ExtractionSettings: extractionSettings,
  ExtractionBudget: extractionBudget,
  BackupSettings: backupSettings,
  RetentionSettings: retentionSettings,
  MyDreamSettings: myDreamSettings,
  SpaceImport: spaceImport,
  SpaceExport: spaceExport,
  LoreImport: loreImport,
  AppearanceSettings: appearanceSettings,
  SpaceExtractionSettings: spaceExtractionSettings,
  SpaceTransferSettings: spaceTransferSettings,
  ModelSettings: modelSettings,
  MasterKeySettings: masterKeySettings,
  DataSettings: dataSettings,
  SettingsPage: settingsPage,
}

const keysOf = (group: string) =>
  SETTINGS_SECTIONS.filter((s) => s.group === group).map((s) => s.key)
const admin = { isAdmin: true, role: 'owner' as const }
const member = { isAdmin: false, role: 'viewer' as const }

describe('小节的注册', () => {
  it('三组按分页的顺序，组内顺序和 demo 一致', () => {
    expect(SETTINGS_GROUPS.map((g) => [g.key, g.label])).toEqual([
      ['account', '个人'],
      ['space', '空间'],
      ['instance', '实例'],
    ])
    expect(keysOf('account')).toEqual(['account', 'appearance'])
    expect(keysOf('space')).toEqual(['general', 'members', 'recall', 'extraction', 'transfer'])
    expect(keysOf('instance')).toEqual([
      'accounts',
      'spaces',
      'models',
      'security',
      'data',
      'prompts',
      'system',
    ])
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      '账号与登录',
      '外观',
      '概况',
      '成员',
      '召回与启动加载',
      '抽取与整理',
      '导入与导出',
      '账号',
      '空间',
      '模型',
      '安全',
      '数据与保留',
      '提示词与默认值',
      '系统信息',
    ])
  })

  it('每个小节都有图标，图标都登记过；小节名不写来源', () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.icon, section.key).toMatch(/^i-lucide-/)
      expect(section.label).not.toContain('Lore')
    }
  })

  it('小节的组件按需加载', () => {
    const registry = /export const SETTINGS_SECTIONS = \[[^]*?\] as const/.exec(
      settingsSectionsSource,
    )![0]
    expect(registry.match(/component: lazy\(\(\) => import\(/g)).toHaveLength(
      SETTINGS_SECTIONS.length,
    )
  })

  it('个人组一直有；空间组要有空间；实例组只给实例管理员', () => {
    expect(visibleGroups({ ...admin, hasSpace: true })).toEqual(['account', 'space', 'instance'])
    expect(visibleGroups({ ...member, hasSpace: true })).toEqual(['account', 'space'])
    expect(visibleGroups({ ...member, hasSpace: false })).toEqual(['account'])
    expect(visibleSections('space', member).map((s) => s.key)).toEqual([
      'general',
      'members',
      'recall',
      'extraction',
      'transfer',
    ])
  })

  it('地址里的小节不存在或看不到时看第一个看得到的', () => {
    const sections = visibleSections('instance', admin)
    expect(currentSection(sections, 'data')?.key).toBe('data')
    expect(currentSection(sections, undefined)?.key).toBe('accounts')
    expect(currentSection(sections, 'nonsense')?.key).toBe('accounts')
    expect(currentSection(sections, ['data'])?.key).toBe('accounts')
    expect(currentSection([], 'data')).toBeUndefined()
  })
})

describe('设置的地址', () => {
  const children = routes.find((r) => r.path === '/')!.children!
  const record = (name: string) => children.find((r) => r.name === name)!

  it('三组各一个地址，各是一个路由组件：换组时换掉整页，离开前的确认各组自己注册', () => {
    expect(record('account-settings').path).toBe('settings/account/:section?')
    expect(record('space-settings').path).toBe('spaces/:spaceId/settings/:section?')
    expect(record('instance-settings').path).toBe('settings/instance/:section?')
    const components = ['account-settings', 'space-settings', 'instance-settings'].map(
      (name) => record(name).component,
    )
    expect(new Set(components).size).toBe(3)
    for (const [name, page] of [
      ['account', accountSettingsPage],
      ['space', spaceSettingsPage],
      ['instance', instanceSettingsPage],
    ] as const) {
      expect(page, name).toContain(`<SettingsPage group="${name}" />`)
      expect(routesSource).toContain(
        `import('./pages/${name[0]!.toUpperCase()}${name.slice(1)}SettingsPage.vue')`,
      )
    }
  })

  it('实例组只给管理员', () => {
    expect(record('instance-settings').meta).toEqual({ requiresAdmin: true })
    expect(routesSource).toContain('if (to.meta.requiresAdmin && !me.isAdmin)')
  })

  it('旧的实例设置地址跳到合并后的小节，不带小节的去个人组', () => {
    const redirect = record('settings').redirect as (to: unknown) => unknown
    const go = (query: Record<string, string>) => redirect({ query })
    const to = (section: string) => ({
      name: 'instance-settings',
      params: { section },
      query: {},
    })
    expect(go({ section: 'embedding' })).toEqual(to('models'))
    expect(go({ section: 'extraction' })).toEqual(to('models'))
    expect(go({ section: 'master-key' })).toEqual(to('security'))
    for (const section of ['backup', 'retention', 'recall']) {
      expect(go({ section })).toEqual(to('data'))
    }
    // 导入空间搬到了空间组，实例组里没有对应的小节了
    expect(go({ section: 'import' })).toEqual(accountSettingsRoute())
    expect(go({})).toEqual({ name: 'account-settings', params: {}, query: {} })
    expect(go({ section: 'constructor' })).toEqual(accountSettingsRoute())
    expect(legacySettingsRedirect({ section: ['backup'] })).toEqual(accountSettingsRoute())
  })

  it('旧的空间设置地址跳到合并后的小节', () => {
    const enter = record('space-settings').beforeEnter as (to: unknown) => unknown
    const go = (section: string | undefined, query: Record<string, string>) =>
      enter({ params: { spaceId: 's1', ...(section ? { section } : {}) }, query })
    const to = (section?: string) => ({
      name: 'space-settings',
      params: section ? { spaceId: 's1', section } : { spaceId: 's1' },
      query: {},
    })
    expect(go(undefined, { section: 'budget' })).toEqual(to('extraction'))
    expect(go(undefined, { section: 'dream' })).toEqual(to('extraction'))
    for (const section of ['export', 'import', 'lore']) {
      expect(go(undefined, { section })).toEqual(to('transfer'))
    }
    expect(go(undefined, { section: 'layers' })).toEqual(to())
    expect(go(undefined, {})).toBe(true)
    expect(go('transfer', { section: 'budget' })).toBe(true)
    expect(legacySpaceSettingsRedirect('s1', {})).toBeNull()
  })

  it('别的页面链到合并后的小节', () => {
    expect(spaceSettingsRoute('s1', 'extraction')).toEqual({
      name: 'space-settings',
      params: { spaceId: 's1', section: 'extraction' },
      query: {},
    })
    expect(instanceSettingsRoute('data')).toEqual({
      name: 'instance-settings',
      params: { section: 'data' },
      query: {},
    })
    expect(overviewPage).toContain(`:to="spaceSettingsRoute(spaceId, 'extraction')"`)
    expect(overviewPage).toContain(`:to="instanceSettingsRoute('data')"`)
    expect(overviewPage).toContain(`:to="instanceSettingsRoute('models')"`)
    expect(overviewPage).not.toContain("name: 'settings'")
    expect(dreamSuggestions).toContain(`:to="spaceSettingsRoute(spaceId, 'extraction')"`)
    expect(benchAgent).toContain("to: instanceSettingsRoute('models')")
  })

  it('同一组里换空间算离开，换小节不算；换组是换路由组件，由离开路由的确认处理', () => {
    const at = (section: string, spaceId?: string) => ({
      params: { section, ...(spaceId ? { spaceId } : {}) },
    })
    expect(leavesSettingsPage(at('data'), at('models'))).toBe(false)
    expect(leavesSettingsPage(at('transfer', 's1'), at('extraction', 's1'))).toBe(false)
    expect(leavesSettingsPage(at('extraction', 's2'), at('extraction', 's1'))).toBe(true)
    // 外壳不再给页面加 key
    expect(consoleLayout).toContain('<RouterView v-else />')
    expect(consoleLayout).not.toContain('settingsPageKey')
  })

  it('换空间之后小节按新空间重新挂上，旧空间的改动标记清掉', () => {
    const component = elementsOf(template(settingsPage)).find((el) => el.tag === 'component')!
    expect(bound(component, 'key')).toBe('`${section}:${spaceKey}`')
    expect(scriptOf(settingsPage)).toMatch(
      /watch\(spaceKey, \(\) => \{\s*for \(const key of Object\.keys\(dirty\)\) delete dirty\[key\]/,
    )
  })

  it('个人与实例页面上的空间组是最近访问的空间，不是第一个', () => {
    const a = { id: 'a', name: 'A', role: 'owner' as const }
    const b = { id: 'b', name: 'B', role: 'editor' as const }
    // 地址里有空间时只认它，不是成员就是 null
    expect(pickSpace([a, b], 'b', 'a')).toBe(b)
    expect(pickSpace([a, b], 'c', 'a')).toBeNull()
    // 地址里没有时取最近访问的；它已不在成员的空间里时退回第一个
    expect(pickSpace([a, b], undefined, 'b')).toBe(b)
    expect(pickSpace([a, b], undefined, 'gone')).toBe(a)
    expect(pickSpace([a, b], undefined, null)).toBe(a)
    expect(pickSpace([], undefined, 'b')).toBeNull()
    // 进入带空间的地址（导航成功）时记下，sessionStorage 读写出错时只在内存里记
    expect(routesSource).toContain(
      "if (!failure && typeof to.params.spaceId === 'string') rememberSpace(to.params.spaceId)",
    )
    expect(useSessionSource).toMatch(/try \{\s*return sessionStorage\.getItem/)
    expect(useSessionSource).toMatch(/try \{\s*sessionStorage\.setItem/)
  })

  const me = {
    id: 'u',
    username: 'u',
    displayName: 'U',
    isAdmin: false,
    spaces: [
      { id: 'a', name: '空间甲', role: 'owner' as const },
      { id: 'b', name: '空间乙', role: 'editor' as const },
    ],
  }
  // 不带空间的地址上 useSession 给的空间名
  const spaceOnAccountPage = async () => {
    const client = new QueryClient()
    client.setQueryData(ME_KEY, me)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/settings/account', component: { render: () => null } }],
    })
    await router.push('/settings/account')
    const Probe = defineComponent(() => {
      const { space } = useSession()
      return () => space.value?.name ?? ''
    })
    const app = createSSRApp(Probe)
    app.use(router)
    app.use(VueQueryPlugin, { queryClient: client })
    return renderToString(app)
  }

  it('只记当前账号是成员的空间；退出登录、会话失效时清掉', async () => {
    sharedClient.setQueryData(ME_KEY, me)
    forgetSpace()
    rememberSpace('b')
    expect(await spaceOnAccountPage()).toBe('空间乙')
    // 不是成员的地址不顶掉上一次的空间
    rememberSpace('not-a-member')
    expect(await spaceOnAccountPage()).toBe('空间乙')
    forgetSpace()
    expect(await spaceOnAccountPage()).toBe('空间甲')
    // 没登录时不记
    sharedClient.setQueryData(ME_KEY, null)
    rememberSpace('b')
    sharedClient.setQueryData(ME_KEY, me)
    expect(await spaceOnAccountPage()).toBe('空间甲')
    expect(consoleLayout).toContain('if (m === null) forgetSpace()')
    const logout = consoleLayout.slice(consoleLayout.indexOf('async function logout'))
    expect(logout.indexOf('forgetSpace()')).toBeLessThan(logout.indexOf('queryClient.clear()'))
    sharedClient.clear()
  })

  it('在空间 B 里打开过设置，到个人页面时空间组还是 B', async () => {
    const client = new QueryClient()
    client.setQueryData(ME_KEY, me)
    sharedClient.setQueryData(ME_KEY, me)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/spaces/:spaceId', component: { render: () => null } },
        { path: '/settings/account', component: { render: () => null } },
      ],
    })
    router.afterEach((to) => {
      if (typeof to.params.spaceId === 'string') rememberSpace(to.params.spaceId)
    })
    await router.push('/spaces/b')
    await router.push('/settings/account')
    const Probe = defineComponent(() => {
      const { space } = useSession()
      return () => space.value?.name ?? ''
    })
    const app = createSSRApp(Probe)
    app.use(router)
    app.use(VueQueryPlugin, { queryClient: client })
    expect(await renderToString(app)).toBe('空间乙')
  })
})

describe('设置页的骨架', () => {
  const groups: SettingsFrameGroup[] = [
    {
      key: 'account',
      label: '个人',
      icon: 'i-lucide-user',
      to: '/a',
      aside: '审阅者',
      sections: [{ key: 'appearance', label: '外观', icon: 'i-lucide-sun-moon', to: '/a' }],
    },
    {
      key: 'instance',
      label: '实例',
      icon: 'i-lucide-server',
      to: '/i/models',
      aside: '仅管理员',
      sections: [
        { key: 'models', label: '模型', icon: 'i-lucide-cpu', to: '/i/models' },
        { key: 'data', label: '数据与保留', icon: 'i-lucide-database', to: '/i/data' },
      ],
    },
  ]
  const frame = (current: string, unsavedKey?: string) =>
    render(
      SettingsFrame,
      {
        group: 'instance',
        current,
        groups: groups.map((g) => ({
          ...g,
          sections: g.sections.map((s) => ({ ...s, unsaved: s.key === unsavedKey })),
        })),
      },
      { default: ({ section }: { section: string }) => `内容 ${section}` },
    )
  // 渲染结果里一个小节的 section 标签
  const sectionTag = (html: string, label: string) =>
    new RegExp(`<section[^>]*aria-label="${label}"[^>]*>`).exec(html)![0]
  const currentLinks = (html: string) => [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)]

  // 渲染结果里一个 nav 的内容
  const navOf = (html: string, label: string) =>
    new RegExp(`<nav[^>]*aria-label="${label}"[^>]*>.*?</nav>`).exec(html)![0]
  const linksOf = (html: string) => [...html.matchAll(/<a[^>]*>.*?<\/a>/g)].map((m) => m[0])
  const styleOf = (source: string) => parse(source).descriptor.styles[0]!.content
  const rule = (css: string, selector: string) =>
    new RegExp(`\\${selector} \\{[^}]*\\}`).exec(css)![0]

  it('标题下面一行分页列出所有组，组名后面带那一句，悬停里是完整的', async () => {
    const tabs = linksOf(navOf(await frame('data'), '设置的分组'))
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toContain('href="/a"')
    expect(tabs[0]).toContain('个人')
    expect(tabs[0]).toContain('审阅者')
    expect(tabs[0]).toMatch(/<span[^>]*title="审阅者"[^>]*>审阅者</)
    expect(tabs[0]).not.toContain('aria-current')
    expect(tabs[1]).toContain('href="/i/data"')
    expect(tabs[1]).toMatch(/<span[^>]*title="仅管理员"[^>]*>仅管理员</)
    expect(tabs[1]).toContain('aria-current="page"')
    // 图标旁一定有文字
    for (const tab of tabs) expect(tab).toMatch(/class="[^"]*group-label[^"]*"/)
  })

  it('只有一组时分页还在：这一组是谁的写在上面', async () => {
    const html = await render(SettingsFrame, {
      group: 'account',
      current: 'appearance',
      groups: groups.slice(0, 1),
    })
    const tabs = linksOf(navOf(html, '设置的分组'))
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toContain('审阅者')
  })

  it('左栏只列当前这一组的小节', async () => {
    const side = navOf(await frame('data'), '设置的小节')
    expect(linksOf(side).map((a) => /href="([^"]*)"/.exec(a)![1])).toEqual(['/i/models', '/i/data'])
    expect(side).not.toContain('外观')
    expect(side).not.toContain('仅管理员')
  })

  it('两个导航的名字不一样', () => {
    const navs = elementsOf(template(settingsFrame)).filter((el) => el.tag === 'nav')
    expect(
      navs.map((el) => el.props?.find((p) => p.name === 'aria-label')?.value?.content),
    ).toEqual(['设置的分组', '设置的小节'])
  })

  it('只有右边那一栏滚动：标题、分页与左栏不跟着滚，也没有贴顶的行盖在内容上', () => {
    const css = styleOf(settingsFrame)
    expect(css).not.toContain('position: sticky')
    const [wide, narrow] = css.split('@media (max-width: 1023.98px)')
    expect(rule(wide!, '.settings-main')).toContain('overflow-y: auto;')
    expect(rule(wide!, '.settings')).not.toContain('overflow')
    const scroller = elementsOf(template(settingsFrame)).find((el) =>
      el.props?.some((p) => p.name === 'ref' && p.value?.content === 'scroller'),
    )!
    expect(scroller.props?.find((p) => p.name === 'class')?.value?.content).toBe('settings-main')
    expect(rule(narrow!, '.settings-tab')).toContain('min-height: 44px;')
  })

  it('当前这一组的小节一直挂着，只显示当前这一节；别的组不挂', async () => {
    const html = await frame('data')
    expect(html).toContain('内容 models')
    expect(html).toContain('内容 data')
    expect(html).not.toContain('内容 appearance')
    expect(sectionTag(html, '数据与保留')).not.toContain('display:none')
    expect(sectionTag(html, '模型')).toContain('display:none')
  })

  it('模板里用 v-show 不用 v-if：切走再回来，填了一半的表单还在', () => {
    const section = elementsOf(template(settingsFrame)).find((el) => el.tag === 'section')!
    expect(directive(section, 'show')?.exp?.content).toBe('section.key === current')
    expect(directive(section, 'if')).toBeUndefined()
  })

  it('分页标出当前组，左栏标出当前小节', async () => {
    const html = await frame('data')
    expect(currentLinks(html)).toHaveLength(2)
    const current = currentLinks(navOf(html, '设置的小节'))
    expect(current).toHaveLength(1)
    expect(current[0]![0]).toContain('href="/i/data"')
  })

  it('组内切小节不留历史记录，换组照常留', () => {
    const [tab, link] = elementsOf(template(settingsFrame)).filter((el) => el.tag === 'RouterLink')
    // 当前组的分页就是现在这一页（aria-current 说的是实话），别的组去它的第一节
    expect(bound(tab!, 'to')).toBe('g.key === group && currentPane ? currentPane.to : g.to')
    expect(tab!.props?.some((p) => p.name === 'replace')).toBe(false)
    expect(bound(link!, 'to')).toBe('section.to')
    expect(link!.props?.some((p) => p.name === 'replace' && p.exp === undefined)).toBe(true)
  })

  it('有未保存改动的小节在左栏标出来', async () => {
    const html = await frame('models', 'data')
    const tabs = [...html.matchAll(/<a[^>]*>.*?<\/a>/g)].map((m) => m[0])
    expect(
      tabs.filter((tab) => tab.includes('未保存')).map((tab) => tab.includes('数据与保留')),
    ).toEqual([true])
  })

  it('切换时记下滚动位置，当前小节滚进左栏的可见范围', () => {
    const script = scriptOf(settingsFrame)
    expect(script).toContain('positions.set(previous, area.scrollTop)')
    expect(script).toContain('area.scrollTop = positions.get(next) ?? 0')
    expect(script).toContain("scrollIntoView({ block: 'nearest', inline: 'nearest' })")
  })
})

describe('一块设置', () => {
  it('标题、说明、内容都在，没有说明时不留空行', async () => {
    const withNote = await render(
      SettingsBlock,
      { title: '备份' },
      { note: () => '每天备份', default: () => '表单' },
    )
    expect(withNote).toContain('备份')
    expect(withNote).toContain('<h3')
    expect(withNote).toContain('block-note')
    expect(withNote).toContain('表单')
    expect(withNote).not.toContain('under-heading')
    const bare = await render(SettingsBlock, { title: '最近备份' }, { default: () => '状态' })
    expect(bare).not.toContain('block-note')
    expect(bare).toContain('under-heading')
  })

  it('标题栏的操作放进 actions', async () => {
    const html = await render(SettingsBlock, { title: '存储桶' }, { actions: () => '刷新' })
    expect(html).toContain('刷新')
  })
})

describe('设置行与保存条', () => {
  it('设置行：名称、说明、控件、取值来源', async () => {
    const html = await render(
      SettingsRow,
      { label: '最低分', description: '低于它的不注入', for: 'min-score' },
      { default: () => '控件', source: () => '沿用实例' },
    )
    expect(html).toContain('<label for="min-score"')
    for (const text of ['最低分', '低于它的不注入', '控件', '沿用实例']) {
      expect(html).toContain(text)
    }
    const bare = await render(SettingsRow, { label: '主题' }, { default: () => '控件' })
    expect(bare).not.toContain('row-source')
    expect(bare).not.toContain('row-description')
    expect(bare).not.toContain('<label')
  })

  it('有填得不对的项时保存条写出原因', async () => {
    const html = await render(SaveBar, { count: 1, problem: '保留天数超出范围' })
    expect(html).toContain('保留天数超出范围')
    expect(await render(SaveBar, { count: 1 })).not.toContain('save-problem')
  })

  it('保存条：写改了几项，没有改动时不显示', async () => {
    expect(await render(SaveBar, { count: 2 })).toContain('2 项未保存')
    expect(await render(SaveBar, { count: 0 })).not.toContain('未保存')
    // 保存刚发出去、改动已经算不出时，条还在，按钮都不能点
    expect(await render(SaveBar, { count: 0, saving: true })).toContain('save-bar')
  })

  it('保存是提交按钮，保存中两个按钮都不能点', () => {
    const buttons = elementsOf(template(saveBar)).filter((el) => el.tag === 'UButton')
    const save = buttons.find((b) => textOf(b) === '保存')!
    expect(attr(save, 'type')).toBe('submit')
    expect(bound(save, 'loading')).toBe('props.saving')
    expect(bound(save, 'disabled')).toBe('props.saving || Boolean(props.problem)')
    const discard = buttons.find((b) => textOf(b) === '放弃')!
    expect(bound(discard, 'disabled')).toBe('props.saving')
    expect(attr(discard, 'color')).toBe('neutral')
    expect(handler(discard, 'click')).toBe("emit('discard')")
  })

  it('用保存条的表单：保存条在表单里，放弃回到读到的值', () => {
    for (const [name, source] of [
      ['ExtractionBudget', extractionBudget],
      ['RetentionSettings', retentionSettings],
    ] as const) {
      const form = elementsOf(template(source)).find((el) => el.tag === 'form')!
      const bar = elementsOf(form).find((el) => el.tag === 'SaveBar')!
      expect(bar, name).toBeDefined()
      expect(handler(bar, 'discard'), name).toBe('discard')
      expect(bound(bar, 'count'), name).toBe('changedCount')
      expect(bound(bar, 'saving'), name).toBe('saving')
    }
  })

  it('保留期的两项只存改了的：分别调各自的接口，失败用 toast', () => {
    const save = /async function save\(\)[^]*?\n\}/.exec(scriptOf(retentionSettings))![0]
    expect(save).toContain('if (saving.value || changedCount.value === 0 || problem.value) return')
    expect(save).toContain('const retention = days.changed.value ? days.value.value : null')
    expect(save).toContain(
      'const recall = recallDays.changed.value ? recallDays.value.value : null',
    )
    expect(save).toContain('days.commit(retention, saved.days)')
    expect(save).toContain('recallDays.commit(recall, saved.retentionDays)')
    expect(save).toContain('api.saveRetentionDays({ days: retention })')
    expect(save).toContain('api.saveRecallSettings({ retentionDays: recall })')
    expect(save).toContain('Promise.allSettled(')
    expect(save).toContain("color: 'error'")
    // 召回分析与概览的「从未被召回」都按召回明细的保留天数算
    expect(save).toContain("invalidateQueries({ queryKey: ['recall-stats'] })")
    expect(save).toContain("invalidateQueries({ queryKey: ['overview'] })")
  })
})

describe('数值设置的表单值', () => {
  const setup = () => {
    const saved = ref<number | undefined>(undefined)
    const field = useSavedField(() => saved.value, { min: 1, max: 3650 })
    return { saved, field }
  }
  const loaded = async (initial = 30) => {
    const it = setup()
    it.saved.value = initial
    await nextTick()
    return it
  }

  it('读到之前不算改动，读到后表单跟上', async () => {
    const { saved, field } = setup()
    expect(field.changed.value).toBe(false)
    saved.value = 30
    await nextTick()
    expect(field.value.value).toBe(30)
    expect(field.baseline.value).toBe(30)
    expect(field.changed.value).toBe(false)
  })

  it('别处改了、本地没动：表单与基准一起跟上，不算未保存', async () => {
    const { saved, field } = await loaded()
    saved.value = 45
    await nextTick()
    expect(field.value.value).toBe(45)
    expect(field.changed.value).toBe(false)
  })

  it('本地改过：输入留着，基准跟着服务端最新的值；放弃回到最新的值', async () => {
    const { saved, field } = await loaded()
    field.value.value = 45
    saved.value = 60
    await nextTick()
    expect(field.value.value).toBe(45)
    expect(field.baseline.value).toBe(60)
    expect(field.changed.value).toBe(true)
    field.reset()
    expect(field.value.value).toBe(60)
    expect(field.changed.value).toBe(false)
  })

  it('本地改成和服务端新值一样：不算改动', async () => {
    const { saved, field } = await loaded()
    field.value.value = 60
    saved.value = 60
    await nextTick()
    expect(field.changed.value).toBe(false)
  })

  it('保存之后以存下的值为基准；保存期间又改了输入时留着新输入', async () => {
    const done = await loaded()
    done.field.value.value = 60
    done.field.commit(60, 60)
    expect(done.field.value.value).toBe(60)
    expect(done.field.changed.value).toBe(false)

    const typing = await loaded()
    typing.field.value.value = 60
    // 请求发出之后又输入了 70
    typing.field.value.value = 70
    typing.field.commit(60, 60)
    expect(typing.field.value.value).toBe(70)
    expect(typing.field.baseline.value).toBe(60)
    expect(typing.field.changed.value).toBe(true)
  })

  it('清空、小数、超出范围都算不合法，并说出是哪一种', async () => {
    const { field } = await loaded()
    const cases: [number | null | undefined, string][] = [
      [null, 'empty'],
      [undefined, 'empty'],
      [1.5, 'fraction'],
      [0, 'range'],
      [3651, 'range'],
    ]
    for (const [bad, issue] of cases) {
      field.value.value = bad
      expect(field.issue.value, String(bad)).toBe(issue)
      expect(field.invalid.value, String(bad)).toBe(true)
    }
    field.value.value = 3650
    expect(field.issue.value).toBeNull()
  })

  it('保存条上写出是哪一项、怎么不对', () => {
    expect(
      fieldProblems([
        { label: '已删除的记忆', issue: 'empty' },
        { label: '召回明细', issue: 'fraction' },
      ]),
    ).toBe('已删除的记忆：未填写；召回明细：需为整数')
    expect(fieldProblems([{ label: '召回明细', issue: null }])).toBeNull()
  })

  it('保留期与抽取预算都用它：不合法时禁用保存，那一行写出范围（完整的句子带句号）', () => {
    for (const [name, source, fields] of [
      ['RetentionSettings', retentionSettings, ['days', 'recallDays']],
      ['ExtractionBudget', extractionBudget, ['monthly', 'daily']],
    ] as const) {
      const elements = elementsOf(template(source))
      expect(
        bound(
          elements.find((el) => el.tag === 'SaveBar')!,
          'problem',
        ),
        name,
      ).toBe('problem')
      expect(source, name).toContain('fieldProblems([')
      const notes = elements.filter(
        (el) => el.tag === 'p' && condition(el)?.endsWith('.invalid.value'),
      )
      expect(notes.map(condition), name).toEqual(fields.map((f) => `${f}.invalid.value`))
      for (const note of notes) expect(textOf(note), name).toMatch(/^请填写 .+ 之间的整数。$/)
      const save = /async function save\(\)[^]*?\n\}/.exec(scriptOf(source))![0]
      expect(save, name).toContain(
        'if (saving.value || changedCount.value === 0 || problem.value) return',
      )
    }
    expect(extractionBudget).toContain('monthly.commit(monthlyTokens, saved.monthlyTokens)')
    expect(extractionBudget).toContain(
      'daily.commit(dailyWritesPerSubject, saved.dailyWritesPerSubject)',
    )
    expect(extractionBudget).not.toContain('form.monthlyTokens')
  })

  it('缩短保留期的警告和改动、保存一样拿基准比', () => {
    const shortened = /const shortened = computed\(\(\) => \{[^]*?\n\}\)/.exec(
      scriptOf(retentionSettings),
    )![0]
    expect(shortened).toContain('const base = days.baseline.value')
    expect(shortened).not.toContain('view.value.days')
  })
})

describe('设置页', () => {
  it('页面换成了新骨架，没有老外壳', () => {
    for (const [name, source] of Object.entries(settingsSources)) {
      for (const old of ['UDashboardPanel', 'UDashboardNavbar', '<UCard', '<UAlert', '<UBadge']) {
        expect(source, `${name} ${old}`).not.toContain(old)
      }
    }
    expect(settingsPage).toContain('<SettingsFrame')
    expect(homePage).not.toContain('UDashboardPanel')
  })

  it('小节的组件经 v-model:dirty 把改动报给页面', () => {
    const component = elementsOf(template(settingsPage)).find((el) => el.tag === 'component')!
    expect(directive(component, 'model')?.arg?.content).toBe('dirty')
    expect(directive(component, 'model')?.exp?.content).toBe('dirty[section]')
    expect(scriptOf(settingsPage)).toContain('unsaved: Boolean(dirty[section.key])')
    // 分页链到组里第一个看得到的小节
    expect(scriptOf(settingsPage)).toContain('to: linkTo(key, list[0]!.key),')
  })

  it('敏感级不再用彩色徽章', () => {
    expect(loreImport).not.toContain('sensitivityColors')
    expect(
      bound(
        elementsOf(template(loreImport)).find((el) => el.tag === 'StrataSwatch')!,
        'sensitivity',
      ),
    ).toBe('sensitivityOf(node, target)')
  })

  it('只注册一份未保存确认，组内切小节不算离开，换组、换空间算', () => {
    const script = scriptOf(settingsPage)
    expect(script.match(/useUnsavedChangesGuard\(/g)).toHaveLength(1)
    expect(script).toContain('useUnsavedChangesGuard(anyDirty, { leavesOn: leavesSettingsPage })')
    for (const [name, source] of Object.entries(settingsSources)) {
      if (name === 'SettingsPage') continue
      expect(source, name).not.toContain('useUnsavedChangesGuard(')
    }
  })

  it('合在一页的小节把各自的改动合起来报给页面', () => {
    const models = elementsOf(template(modelSettings))
    expect(
      ['EmbeddingSettings', 'ExtractionSettings'].map(
        (tag) =>
          directive(
            models.find((e) => e.tag === tag)!,
            'model',
          )?.exp?.content,
      ),
    ).toEqual(['dirty.embedding', 'dirty.extraction'])
    expect(modelSettings).toContain(
      "const dirty = useDirtyParts(dirtyModel, ['embedding', 'extraction'])",
    )
    const data = elementsOf(template(dataSettings))
    expect(
      ['RetentionSettings', 'BackupSettings'].map(
        (tag) =>
          directive(
            data.find((e) => e.tag === tag)!,
            'model',
          )?.exp?.content,
      ),
    ).toEqual(['dirty.retention', 'dirty.backup'])
    expect(dataSettings).toContain(
      "const dirty = useDirtyParts(dirtyModel, ['retention', 'backup'])",
    )
    const extraction = elementsOf(template(spaceExtractionSettings))
    expect(
      ['ExtractionBudget', 'SpaceAdvancedExtraction'].map(
        (tag) =>
          directive(
            extraction.find((e) => e.tag === tag)!,
            'model',
          )?.exp?.content,
      ),
    ).toEqual(['dirty.budget', 'dirty.advanced'])
    expect(spaceExtractionSettings).toContain(
      "const dirty = useDirtyParts(dirtyModel, ['budget', 'advanced'])",
    )
    expect(extractionBudget).toContain('watch(dirty, (d) => (dirtyModel.value = d)')
    expect(extractionBudget).toContain('const dirty = computed(() => changedCount.value > 0)')
    expect(scriptOf(embeddingSettings).match(/\[activeDirty, nextDirty\]/g)).toHaveLength(1)
    expect(embeddingSettings).toContain('dirtyModel.value = a || n')
    expect(extractionSettings).toContain('dirtyModel.value = changed')
    expect(backupSettings).toContain('dirtyModel.value = changed')
    expect(retentionSettings).toContain('(changed) => (dirtyModel.value = changed)')
  })

  it('回车提交还在：每个表单提交到原来的处理函数，都有提交按钮', () => {
    const forms: [string, string, string][] = [
      ['EmbeddingSettings', embeddingSettings, 'saveActive'],
      ['EmbeddingSettings', embeddingSettings, 'saveNext'],
      ['EmbeddingSettings', embeddingSettings, 'askStart'],
      ['ExtractionSettings', extractionSettings, 'save'],
      ['BackupSettings', backupSettings, 'save'],
      ['SpaceExport', spaceExport, 'exportSpace'],
      ['SpaceImport', spaceImport, 'preview ? importSpace() : inspect()'],
    ]
    for (const [name, source, submit] of forms) {
      const form = elementsOf(template(source)).find(
        (el) => el.tag === 'form' && handler(el, 'submit') === submit,
      )
      expect(form, `${name} ${submit}`).toBeDefined()
      expect(
        elementsOf(form!).some((el) => el.tag === 'UButton' && attr(el, 'type') === 'submit'),
        `${name} ${submit}`,
      ).toBe(true)
    }
    // 保存条里的保存是提交按钮
    for (const [name, source] of [
      ['ExtractionBudget', extractionBudget],
      ['RetentionSettings', retentionSettings],
    ] as const) {
      const form = elementsOf(template(source)).find(
        (el) => el.tag === 'form' && handler(el, 'submit') === 'save',
      )
      expect(form, name).toBeDefined()
      expect(
        elementsOf(form!).some((el) => el.tag === 'SaveBar'),
        name,
      ).toBe(true)
    }
  })

  it('一页只有一个实心按钮，砖红只给破坏性操作', () => {
    for (const [name, source] of Object.entries({ ...settingsSources, SaveBar: saveBar })) {
      const buttons = buttonsOutsideModals(template(source))
      // 外观的主题按钮按当前选择切换样式，不算固定的实心按钮
      const solid = buttons.filter((b) => !attr(b, 'variant') && !bound(b, 'variant'))
      expect(
        solid.map(textOf).filter((t) => !['确认导入', '保存'].includes(t)),
        name,
      ).toEqual([])
      expect(solid.length, name).toBeLessThanOrEqual(1)
      const red = buttons.filter((b) => attr(b, 'color') === 'error').map(textOf)
      expect(
        red.filter((t) => !['放弃', '清除设置'].includes(t)),
        name,
      ).toEqual([])
    }
  })

  it('外观：主题三个选项，用 useColorPreference，当前的标出来', () => {
    expect(appearanceSettings).toContain('useColorPreference()')
    const button = elementsOf(template(appearanceSettings)).find((el) => el.tag === 'UButton')!
    expect(directive(button, 'for')?.exp?.content).toContain('COLOR_PREFERENCES')
    expect(bound(button, 'aria-pressed')).toBe('colorPreference.current() === option.value')
    expect(handler(button, 'click')).toBe('colorPreference.set(option.value)')
  })

  it('渠道不再是圆角卡片，用线分开', () => {
    expect(embeddingChannelRow).not.toContain('rounded-md')
    expect(embeddingChannelRow).toContain('border-t border-default')
  })
})

describe('读取失败', () => {
  // [文件, 查询, 错误后面紧跟的内容的显示条件：不和错误二选一]
  const reads: [string, string, string, string][] = [
    ['MasterKeySettings', masterKeySettings, 'masterKey', 'masterKey.data.value'],
    ['EmbeddingSettings', embeddingSettings, 'settings', 'settings.isPending.value'],
    ['EmbeddingSettings', embeddingSettings, 'status', 'status.data.value'],
    ['ExtractionSettings', extractionSettings, 'settings', 'settings.isPending.value'],
    ['BackupSettings', backupSettings, 'settings', 'settings.isPending.value'],
    // 两样查询的错误挨着，后面才是内容
    ['RetentionSettings', retentionSettings, 'settings', 'recallSettings.isError.value'],
    ['RetentionSettings', retentionSettings, 'recallSettings', 'pause'],
    ['ExtractionBudget', extractionBudget, 'usage', 'usage.isPending.value'],
    ['MyDreamSettings', myDreamSettings, 'settings', 'settings.isPending.value'],
  ]

  it.each(reads)('%s 的 %s：错误放在上面，读到过的内容留着', (name, source, query, shown) => {
    const expression = `${query}.isError.value`
    // 读取失败的一行是 ReadFailureNote：文字、重试、转圈都按这一样查询
    const isNote = (c: TemplateNode) =>
      c.tag === 'ReadFailureNote' && condition(c) === expression && bound(c, 'query') === query
    const siblings = elementsOf(template(source)).find((el) =>
      (el.children ?? []).some(isNote),
    )?.children
    const list = siblings ?? template(source).children ?? []
    const elementsAfter = list.filter((n) => n.type === ELEMENT)
    const index = elementsAfter.findIndex(isNote)
    expect(index, `${name} ${query}`).toBeGreaterThanOrEqual(0)
    // 错误和内容不是二选一
    const next = elementsAfter[index + 1]
    expect(directive(next!, 'else'), name).toBeUndefined()
    expect(directive(next!, 'else-if'), name).toBeUndefined()
    expect(condition(next!), `${name} ${query}`).toBe(shown)
  })

  it('没有数据时重新读取（比如切回窗口），错误会被清掉：表单的条件不能看 isError', async () => {
    const client = new QueryClient()
    const queryKey = ['settings']
    const read = () =>
      client
        .fetchQuery({ queryKey, queryFn: () => Promise.reject(new Error('读取失败')) })
        .catch(() => {})
    await read()
    expect(client.getQueryState(queryKey)).toMatchObject({ status: 'error', data: undefined })
    const again = read()
    expect(client.getQueryState(queryKey)).toMatchObject({
      status: 'pending',
      error: null,
      data: undefined,
    })
    await again
  })

  // [文件, 提交的处理函数, 查询, 有数据的条件, 加载中的条件]
  const forms: [string, string, string, string, string, string][] = [
    [
      'EmbeddingSettings',
      embeddingSettings,
      'saveActive',
      'settings',
      'settings.data.value',
      'settings.isPending.value',
    ],
    [
      'ExtractionSettings',
      extractionSettings,
      'save',
      'settings',
      'settings.data.value',
      'settings.isPending.value',
    ],
    ['BackupSettings', backupSettings, 'save', 'settings', 'view', 'settings.isPending.value'],
    // 两样设置一张表：哪一样读到了就给哪一行，两样都在读时显示骨架
    [
      'RetentionSettings',
      retentionSettings,
      'save',
      'settings',
      'view || recallSettings.data.value',
      'settings.isPending.value || recallSettings.isPending.value',
    ],
  ]

  it.each(forms)(
    '%s 的表单只在读到数据时给：空表单保存会盖掉读不到的那份，加载中显示骨架',
    (name, source, submit, query, data, pending) => {
      const parent = elementsOf(template(source)).find((el) =>
        (el.children ?? []).some((c) => c.tag === 'form' && handler(c, 'submit') === submit),
      )!
      const siblings = parent.children!.filter((n) => n.type === ELEMENT)
      const index = siblings.findIndex((c) => c.tag === 'form' && handler(c, 'submit') === submit)
      const form = siblings[index]!
      expect(directive(form, 'else-if')?.exp?.content, name).toBe(data)
      expect(condition(form), name).toBeUndefined()
      const skeleton = siblings[index - 1]!
      expect(skeleton.tag, name).toBe('USkeleton')
      expect(condition(skeleton), name).toBe(pending)
      expect(source, name).not.toContain(`!${query}.isError.value ||`)
    },
  )

  it('备份表单的改动状态都来自 useBackupForm：和填入时的版本比，不和最新的设置比', () => {
    const script = scriptOf(backupSettings)
    expect(script).toContain(
      'const { form, dirty, commit } = useBackupForm(view, queryClient, queryKey)',
    )
    expect(script).not.toMatch(/const (dirty|form)\b/)
  })

  it('保留期的每一行、备份的右栏也要等读到才有', () => {
    const rows = elementsOf(template(retentionSettings)).filter((el) => el.tag === 'tr')
    expect(rows.slice(1).map(condition)).toEqual(['view', 'recallSettings.data.value'])
    for (const source of [backupSettings]) {
      const side = elementsOf(template(source)).find(
        (el) => el.tag === 'template' && directive(el, 'slot')?.arg?.content === 'side',
      )!
      expect(condition(side)).toMatch(/view$/)
    }
  })

  it('存储桶的列表按位置分开缓存，失效和删除都走前缀：立即备份之后还会刷新', () => {
    const script = scriptOf(backupSettings)
    expect(script).toContain('queryKey: computed(() => backupObjectsKey(view.value))')
    expect(script.match(/invalidateQueries\(\{ queryKey: BACKUP_OBJECTS_KEY \}\)/g)).toHaveLength(2)
    expect(script).toContain('queryClient.removeQueries({ queryKey: BACKUP_OBJECTS_KEY })')
    const finished = /这一次做完了[^]*?\n\}\)/.exec(script)![0]
    expect(finished).toContain('invalidateQueries({ queryKey: BACKUP_OBJECTS_KEY })')
    const save = /async function save\(\)[^]*?\n\}/.exec(script)![0]
    expect(save).toContain('invalidateQueries({ queryKey: BACKUP_OBJECTS_KEY })')
  })

  it('保存之后经 commit 写缓存和表单，再清掉填过的 Secret', () => {
    const save = /async function save\(\)[^]*?\n\}/.exec(scriptOf(backupSettings))![0]
    expect(save).not.toContain('setQueryData')
    expect(save.indexOf('await commit(saved)')).toBeGreaterThan(-1)
    expect(save.indexOf('await commit(saved)')).toBeLessThan(
      save.indexOf("form.secretAccessKey = ''"),
    )
  })

  // 读取失败之后表单不在了，要有地方重新读：ReadFailureNote 按传入的查询给重试（重读的就是它），见 readFailures.test.ts
  it.each([
    ['EmbeddingSettings', embeddingSettings, 'settings'],
    ['EmbeddingSettings', embeddingSettings, 'status'],
    ['ExtractionSettings', extractionSettings, 'settings'],
    ['BackupSettings', backupSettings, 'settings'],
    ['RetentionSettings', retentionSettings, 'settings'],
    ['RetentionSettings', retentionSettings, 'recallSettings'],
    ['MasterKeySettings', masterKeySettings, 'masterKey'],
    ['ExtractionBudget', extractionBudget, 'usage'],
    ['MyDreamSettings', myDreamSettings, 'settings'],
  ])('%s 的 %s 读取失败时有重试，重读的是这一样查询', (name, source, query) => {
    const note = elementsOf(template(source)).find(
      (el) => el.tag === 'ReadFailureNote' && condition(el) === `${query}.isError.value`,
    )
    expect(note, name).toBeDefined()
    expect(bound(note!, 'query'), name).toBe(query)
  })

  it('存储桶的列表出错时只显示错误：外部的状态，错误下面还是旧桶的备份会有误导', () => {
    const elements = elementsOf(template(backupSettings))
    const error = elements.find(
      (el) => el.tag === 'NoteLine' && condition(el) === 'objects.isError.value',
    )
    expect(error).toBeDefined()
    const empty = elements.find((el) => textOf(el) === '暂无备份')!
    expect(condition(empty)).toBeUndefined()
    expect(directive(empty, 'else-if')?.exp?.content).toBe(
      'objects.data.value && !objects.data.value.objects.length',
    )
    const list = elements.find((el) => el.tag === 'ul')!
    expect(condition(list)).toBeUndefined()
    expect(directive(list, 'else-if')?.exp?.content).toBe('objects.data.value')
    // 换了位置之后还没读到时：显示在读，不是上一个位置的列表
    const skeleton = elements.find(
      (el) =>
        el.tag === 'USkeleton' && directive(el, 'else-if')?.exp?.content.startsWith('objects'),
    )!
    expect(directive(skeleton, 'else-if')?.exp?.content).toBe('objects.isPending.value')
  })

  it('错误文字：服务端给了说明就用它', () => {
    for (const [name, source] of Object.entries(settingsSources)) {
      if (!source.includes('isError')) continue
      expect(source, name).not.toMatch(/isError\.value && !/)
    }
    // 服务端没给说明时用具体的说法，和别处的「读取失败」分得开
    expect(backupSettings).toContain("readFailure(objects.error.value, '无法列出备份')")
    expect(embeddingSettings).toContain(
      '<ReadFailureNote v-if="settings.isError.value" :query="settings" />',
    )
    expect(embeddingSettings).not.toContain('读取设置失败')
  })

  it('没读到过时不显示内容：用量和开关都要等读到才有', () => {
    const after = (source: string, tag: string) => {
      const elements = elementsOf(template(source))
      return elements[elements.findIndex((el) => el.tag === tag) + 1]!
    }
    expect(directive(after(extractionBudget, 'USkeleton'), 'else-if')?.exp?.content).toBe(
      'usage.data.value',
    )
    expect(directive(after(myDreamSettings, 'USkeleton'), 'else-if')?.exp?.content).toBe(
      'settings.data.value',
    )
  })

  it('读取中的骨架屏只在还没有结果时显示：失败了不一直转', () => {
    expect(
      condition(elementsOf(template(extractionBudget)).find((el) => el.tag === 'USkeleton')!),
    ).toBe('usage.isPending.value')
    expect(
      condition(elementsOf(template(myDreamSettings)).find((el) => el.tag === 'USkeleton')!),
    ).toBe('settings.isPending.value')
  })
})

describe('标题和说明一直在', () => {
  // 从根走到这个元素，路上经过了哪些元素
  const ancestors = (
    node: TemplateNode,
    target: TemplateNode,
    path: TemplateNode[] = [],
  ): TemplateNode[] | null => {
    if (node === target) return path
    for (const child of node.children ?? []) {
      const found = ancestors(child, target, [...path, node])
      if (found) return found
    }
    return null
  }
  const blocks: [string, string, string][] = [
    ['嵌入模型', embeddingSettings, 'OpenAI 兼容的 /embeddings 接口'],
    ['向量', embeddingSettings, '显示已生成当前模型向量的记忆数量。'],
    ['抽取模型', extractionSettings, 'OpenAI 兼容的 /chat/completions 接口'],
    [
      '主密钥',
      masterKeySettings,
      '用于加密机密记忆、托管的凭据值，以及实例设置中保存的 API Key 与 Secret Access Key。',
    ],
    ['备份', backupSettings, '恢复时需配置同一主密钥。'],
    ['保留期', retentionSettings, '超过保留期的内容将被永久删除，之后只能从备份恢复。'],
    ['抽取预算', extractionBudget, '抽取事实与整理共用此 token 预算。'],
    ['整理', myDreamSettings, '已发送的内容无法撤回。'],
    ['导入', spaceTransferSettings, '将其他工具的记忆导入当前空间，目前仅支持 Lore。'],
    ['Lore', loreImport, '导入 Lore 的节点，确认计划后才写入。'],
  ]

  it.each(blocks)('%s：读取失败或加载中也有标题和后果说明', (title, source, sentence) => {
    const root = template(source)
    const block = elementsOf(root).find(
      (el) => el.tag === 'SettingsBlock' && attr(el, 'title') === title,
    )!
    const path = ancestors(root, block)!
    for (const el of [...path, block]) {
      for (const name of ['if', 'else-if', 'else']) {
        // 小节的插槽和骨架本身没有条件，一路都不能挂在数据上
        expect(directive(el, name), `${title} ${el.tag}`).toBeUndefined()
      }
    }
    const note = (block.children ?? []).find(
      (c) => c.tag === 'template' && directive(c, 'slot')?.arg?.content === 'note',
    )!
    expect(flat(textOf(note))).toContain(flat(sentence))
  })
})

describe('没有权限时', () => {
  it('小节都在，内容和改版前一样收起', () => {
    const ownerOnly = (source: string, text: string) =>
      elementsOf(template(source)).find((el) => textOf(el) === text)
    expect(condition(ownerOnly(spaceExport, '仅空间所有者可导出')!)).toBe('!editable')
    expect(condition(ownerOnly(loreImport, '仅空间所有者可导入')!)).toBe('!editable')
    expect(flat(extractionBudget)).toContain('仅空间所有者可修改预算')
    const budgetForm = elementsOf(template(extractionBudget)).find((el) => el.tag === 'form')!
    expect(condition(budgetForm)).toBe('editable')
  })

  it('空间组的小节把权限传给各块', () => {
    const elements = [
      ...elementsOf(template(spaceExtractionSettings)),
      ...elementsOf(template(spaceTransferSettings)),
    ]
    for (const source of [spaceExtractionSettings, spaceTransferSettings]) {
      expect(source).toContain("const isOwner = computed(() => space.value?.role === 'owner')")
    }
    for (const tag of ['ExtractionBudget', 'SpaceExport', 'LoreImport']) {
      expect(
        bound(
          elements.find((el) => el.tag === tag)!,
          'editable',
        ),
        tag,
      ).toBe('isOwner')
    }
    expect(
      bound(
        elements.find((el) => el.tag === 'LoreImport')!,
        'is-admin',
      ),
    ).toBe('me.data.value?.isAdmin ?? false')
  })

  it('实例设置只给管理员', () => {
    expect(routesSource).toMatch(/name: 'instance-settings',[^}]*meta: \{ requiresAdmin: true \}/)
  })
})

describe('带后果的文字整句留着', () => {
  const sentences: [string, string, string][] = [
    [
      '开始更换模型',
      embeddingSettings,
      '产生大量接口请求。补齐前召回继续使用{{active?.model}}，补齐后自动切换并删除旧模型的向量。',
    ],
    ['立即切换', embeddingSettings, '切换后这些记忆暂时只能通过全文与关键词召回，后台会继续补齐。'],
    ['放弃更换模型', embeddingSettings, '已生成的向量将被删除，召回继续使用{{active?.model}}。'],
    [
      '清除抽取模型',
      extractionSettings,
      '清除后不再从对话中抽取事实，也不再生成会话摘要，对话缓冲到期后直接丢弃。已抽取的记忆不受影响。',
    ],
    [
      '清除备份设置',
      backupSettings,
      '清除后不再定时备份。存储桶中已有的备份不受影响，恢复时仍可使用。',
    ],
    ['备份恢复', backupSettings, '恢复时需配置同一主密钥。'],
    ['保留期', retentionSettings, '超过保留期的内容将被永久删除，之后只能从备份恢复。'],
    ['缩短保留期', retentionSettings, '缩短后，下一次清理将按新的天数永久删除，不可撤销。'],
    ['召回明细', retentionSettings, '召回明细到期后删除，仅保留每条记忆的累计召回次数'],
    [
      '整理',
      myDreamSettings,
      '开启后，当前账号的本人记忆（机密除外）将发送给抽取模型整理，已发送的内容无法撤回。',
    ],
    ['导出口令', spaceExport, 'Kioku不保存口令，丢失后无法打开文件。'],
    ['导出的文件去哪导入', spaceExport, '可在下方「导入空间」将它导入为新空间'],
    [
      '空间文件在哪导入',
      spaceTransferSettings,
      'Kioku 导出的空间文件在下方「导入空间」导入为新空间。',
    ],
    ['导入空间名额用完', spaceImport, '{{ blocked }}，删除或转让一个空间后再导入。'],
    ['导出的口令提示', spaceExport, '请另行保存口令。Kioku不保存口令，丢失后无法打开此文件。'],
    ['导入空间', spaceImport, '仅导入本人导出、或导出人同意移交的文件。'],
    [
      '导入空间的归属',
      spaceImport,
      '其中符合条件的本人记忆将进入当前账号Agent的启动加载。仅导入本人导出、或导出人同意移交的文件。',
    ],
    [
      '导入空间没有主密钥',
      spaceImport,
      '当前实例未配置主密钥：文件包含机密记忆或托管的凭据时无法导入。请先配置KIOKU_MASTER_KEY。',
    ],
    ['Lore 来源', loreImport, '只导入本人导出的文件或本人的Lore'],
    ['Lore 指令', loreImport, '来源不明的内容写入后，会成为当前账号Agent的指令。'],
    [
      'Lore 旧文件',
      loreImport,
      '同步只比较内容是否相同，用旧文件写入会把内容改回旧版，还可能新建已在Lore中删除的节点。建议重新导出；之后上传新的导出文件可同步回来。',
    ],
    ['Lore 中途出错', loreImport, '写入中途出错时，已写入的内容保留，重新生成计划后可继续。'],
    [
      'Lore 明文 API Token',
      loreImport,
      'API Token将明文传输，而此API Token可清空整个Lore。请尽量改用https。',
    ],
    ['Lore 已导入的机密', loreImport, '此前已导入，当前仍为明文，本次标记的机密未生效。'],
    [
      '主密钥',
      masterKeySettings,
      '未配置主密钥，无法保存机密记忆、托管的凭据，以及实例设置中的 API Key 与 Secret Access Key。',
    ],
    [
      '轮换完成',
      masterKeySettings,
      '轮换完成。可以从配置中移除KIOKU_MASTER_KEY_PREVIOUS，然后重启服务。',
    ],
  ]

  it.each(sentences)('%s', (_name, source, sentence) => {
    expect(flat(source)).toContain(flat(sentence))
  })

  it('确认框还在，破坏性的确认按钮是红色', () => {
    const modal = (source: string, title: string) =>
      elementsOf(template(source)).find((el) => el.tag === 'UModal' && attr(el, 'title') === title)!
    for (const [source, title, button, click] of [
      [embeddingSettings, '放弃更换模型？', '放弃', 'abort'],
      [extractionSettings, '清除抽取模型设置？', '清除', 'clear'],
      [backupSettings, '清除备份存储设置？', '清除', 'clear'],
      [retentionSettings, '立即开始清理？', '开始清理', 'resume'],
    ] as const) {
      const confirm = elementsOf(modal(source, title)).find(
        (el) => el.tag === 'UButton' && textOf(el) === button,
      )!
      expect(attr(confirm, 'color'), title).toBe('error')
      expect(handler(confirm, 'click'), title).toBe(click)
    }
    expect(modal(embeddingSettings, '开始更换模型？')).toBeDefined()
    expect(modal(embeddingSettings, '立即切换？')).toBeDefined()
  })

  it('清除中途不能关确认框', () => {
    for (const source of [extractionSettings, backupSettings]) {
      expect(source).toContain(':dismissible="!clearing"')
    }
    expect(retentionSettings).toContain(':dismissible="!resuming"')
  })
})

describe('清除设置', () => {
  const body = (source: string) => /async function clear\(\)[^]*?\n\}/.exec(scriptOf(source))![0]

  it('抽取模型：先按「没有设置」写进缓存再去刷新：刷新失败时不能停在旧的设置上，清空的表单一直算有改动', () => {
    const clear = body(extractionSettings)
    const written = clear.indexOf('queryClient.setQueryData')
    expect(written).toBeGreaterThan(-1)
    expect(clear.indexOf('invalidateQueries({ queryKey')).toBeGreaterThan(written)
    expect(clear).toContain('configured: false')
  })

  it('备份：同样先写再刷新，表单回到空白，填了一半的内容也不留', () => {
    const clear = body(backupSettings)
    const written = clear.indexOf('await commit({')
    expect(written).toBeGreaterThan(-1)
    expect(clear.indexOf('invalidateQueries({ queryKey')).toBeGreaterThan(written)
    expect(clear).toContain('configured: false')
  })
})

describe('Lore 导入', () => {
  const elements = elementsOf(template(loreImport))

  it('计划显示后只有点确认导入才写入，勾选说明和筛选都还在', () => {
    const confirm = elements.find((el) => el.tag === 'UButton' && textOf(el) === '确认导入')!
    expect(bound(confirm, 'disabled')).toBe('!ready || confirmMissing')
    expect(handler(confirm, 'click')).toBe('applyPlan')
    expect(
      bound(
        elements.find((el) => el.tag === 'USelect')!,
        'items',
      ),
    ).toBe('filterItems')
    expect(loreImport).toContain('secretSelectable(node)')
    expect(loreImport).toContain('excludeLabel(node)')
  })

  it('目标 URI 要看全：确认写到哪里，不能被省略号截断', () => {
    const paths = elements.filter((el) => el.tag === 'UriPath')
    expect(paths.length).toBeGreaterThanOrEqual(2)
    for (const el of paths) expect(el.props?.some((p) => p.name === 'wrap')).toBe(true)
  })

  it('标题的宽度跟着计划：看计划时才加宽', () => {
    expect(
      bound(
        elements.find((el) => el.tag === 'SettingsBlock')!,
        'wide',
      ),
    ).toBe('Boolean(plan)')
  })
})

describe('登录', () => {
  const elements = elementsOf(template(loginPage))
  const script = scriptOf(loginPage)

  it('回车提交，账号密码能被密码管理器认出来', () => {
    const form = elements.find((el) => el.tag === 'form')!
    expect(handler(form, 'submit')).toBe('submit')
    expect(elements.filter((el) => attr(el, 'type') === 'submit').map(textOf)).toEqual(['登录'])
    const inputs = elements.filter((el) => el.tag === 'UInput')
    expect(inputs.map((el) => attr(el, 'autocomplete'))).toEqual(['username', 'current-password'])
    for (const input of inputs) {
      expect(input.props?.some((p) => p.name === 'required')).toBe(true)
    }
  })

  it('只回到站内路径，换账号时清掉缓存', () => {
    expect(script).toContain("route.query.next.startsWith('/')")
    expect(script).toContain("!route.query.next.startsWith('//')")
    expect(script).toContain('queryClient.clear()')
    expect(script).toContain('queryClient.setQueryData(ME_KEY, me)')
    expect(script).toContain('await router.replace(next)')
  })

  it('出错时显示服务端的说明', () => {
    const error = elements.find((el) => condition(el) === 'error')!
    expect(attr(error, 'role')).toBe('alert')
    expect(script).toContain("err instanceof ApiError ? err.message : '登录失败'")
  })
})

describe('初始化', () => {
  const elements = elementsOf(template(setupPage))

  it('建管理员按服务端同一个规则校验，字段的提示都在', () => {
    const form = elements.find((el) => el.tag === 'UForm')!
    expect(bound(form, 'schema')).toBe('SetupRequest')
    expect(handler(form, 'submit')).toBe('submitAdmin')
    expect(
      elementsOf(form)
        .filter((el) => el.tag === 'UFormField')
        .map((el) => attr(el, 'name')),
    ).toEqual(['setupCode', 'username', 'displayName', 'password', 'spaceName'])
    expect(elements.filter((el) => attr(el, 'type') === 'submit').map(textOf)).toEqual([
      '检查',
      '创建并登录',
    ])
    expect(flat(setupPage)).toContain('创建首个账号及其空间，该账号为实例管理员。')
  })

  it('数据库这一步：回车只做检查，保存、代建与下一步都要点按钮', () => {
    const buttons = elements.filter((el) => el.tag === 'UButton')
    const byText = (text: string) => buttons.find((el) => textOf(el) === text)!
    expect(attr(byText('保存并接入'), 'type')).toBe('button')
    expect(handler(byText('保存并接入'), 'click')).toBe('connect')
    expect(attr(byText('创建并接入'), 'type')).toBe('button')
    expect(attr(byText('下一步'), 'type')).toBe('button')
    // 代建的表单不放在 <form> 里：输入框里回车不会建库
    const forms = elements.filter((el) => el.tag === 'form')
    expect(forms).toHaveLength(1)
    expect(handler(forms[0]!, 'submit')).toBe('runCheck')
    // 没配主密钥时提醒一句；代建的规则收进提示层，正文只留一句
    expect(flat(setupPage)).toContain('配置KIOKU_MASTER_KEY后重启服务')
    expect(flat(setupPage)).toContain('新建应用角色与库，只保存应用角色的连接。<Hint')
    // 代建时超级用户先连的库可以改，默认 postgres
    expect(setupPage).toContain('label="维护库"')
    expect(setupPage).toContain("maintenance: 'postgres',")
  })

  it('数据库暂时连不上不进初始化页：守卫带到数据库不可用页，那一页不给初始化码', () => {
    expect(routesSource).toContain("if (status.database.state === 'unavailable') {")
    expect(routesSource).toContain("name: 'database-unavailable'")
    expect(setupPage).toContain("await router.replace({ name: 'database-unavailable' })")
    expect(databaseUnavailablePage).not.toContain('setupCode')
    expect(flat(databaseUnavailablePage)).toContain('正在自动重试')
  })

  it('校验的提示是中文：这是装好之后看到的第一屏', () => {
    const issues = SetupRequest.safeParse({
      setupCode: '',
      username: 'lin',
      displayName: '',
      password: 'long-enough-password',
      spaceName: '',
    }).error!.issues
    expect(issues.map((issue) => issue.message)).toEqual([
      '请填写初始化码',
      '请填写显示名',
      '请填写空间名',
    ])
    const tooLong = 'x'.repeat(65)
    const long = SetupRequest.safeParse({
      setupCode: 'abcd',
      username: 'lin',
      displayName: tooLong,
      password: 'long-enough-password',
      spaceName: tooLong,
    }).error!.issues
    expect(long.map((issue) => issue.message)).toEqual([
      '显示名不超过 64 个字符',
      '空间名不超过 64 个字符',
    ])
  })
})

describe('连接失败', () => {
  const script = scriptOf(unavailablePage)

  it('静态引入，用到的公共部分也不按需加载：后端连不上时文件也拿不到', () => {
    expect(routesSource).toContain("import UnavailablePage from './pages/UnavailablePage.vue'")
    expect(routesSource).toContain('component: UnavailablePage')
    expect(unavailablePage).not.toContain('import(')
    expect(entryFrame).not.toContain('import(')
    expect(routesSource).toContain("return { name: 'unavailable', query: { next: to.fullPath } }")
  })

  it('说清楚发生了什么、能做什么', () => {
    const text = flat(unavailablePage)
    expect(text).toContain('无法连接到服务')
    expect(text).toContain('服务可能正在重启或升级，请稍后重试。')
    expect(text).toContain('持续无法连接时，请检查服务进程、数据库与反向代理的状态。')
  })

  it('只回到站内路径：地址还会交给 location.assign，按浏览器的解析结果核对', () => {
    for (const path of [
      '/',
      '/spaces/s1/memories?uri=core://agent',
      '/settings?section=backup#x',
    ]) {
      expect(retryTarget(path)).toBe(path)
    }
    for (const next of [
      '//example.com',
      '//example.com/spaces',
      '/.//example.com',
      '/spaces/..//example.com',
      'https://example.com',
      'spaces/s1',
      '/\\example.com',
      '/\t/example.com',
      '/\n/example.com',
      '//[',
      '',
      undefined,
      ['/spaces'],
    ]) {
      expect(retryTarget(next)).toBe('/')
    }
    expect(script).toContain('retryTarget(route.query.next)')
  })

  const branch = (name: 'if' | 'else') =>
    elementsOf(template(unavailablePage)).find(
      (el) => el.tag === 'template' && directive(el, name) !== undefined,
    )!
  const buttonsOf = (node: TemplateNode) => elementsOf(node).filter((el) => el.tag === 'UButton')
  const titleOf = (node: TemplateNode) =>
    attr(
      elementsOf(node).find((el) => el.tag === 'SectionHeading')!,
      'title',
    )

  it('连不上：重试有反馈，转圈，还是连不上时说一声', () => {
    const unreachable = branch('else')
    expect(titleOf(unreachable)).toBe('无法连接到服务')
    const [button, ...others] = buttonsOf(unreachable)
    expect(others).toEqual([])
    expect(textOf(button!)).toBe('重试')
    expect(bound(button!, 'loading')).toBe('retrying')
    expect(handler(button!, 'click')).toBe('retry')
    const note = elementsOf(unreachable).find((el) => condition(el) === 'failedAt')!
    expect(attr(note, 'role')).toBe('status')
    expect(flat(unavailablePage)).toContain('仍无法连接（{{formatTime(failedAt)}}）')
    expect(script).toContain("if (result === 'unreachable') failedAt.value")
  })

  it('页面文件加载不到：接口是通的，标题、说明都换掉，按钮改成整页跳回目标地址', () => {
    const assets = branch('if')
    expect(condition(assets)).toBe('assetsFailed')
    expect(titleOf(assets)).toBe('页面文件已更新')
    expect(flat(unavailablePage)).toContain('重新载入后回到之前的页面。')
    const [button, ...others] = buttonsOf(assets)
    expect(others).toEqual([])
    expect(textOf(button!)).toBe('重新载入')
    expect(handler(button!, 'click')).toBe('reload')
    expect(script).toContain('const reload = () => window.location.assign(target.value)')
    expect(script).toContain("if (result === 'assets') assetsFailed.value = true")
  })

  // 和实际一样：守卫连不上时转回连接失败页；页面文件按需加载
  const routerFor = async (reachable: boolean) => {
    const empty = { render: () => null }
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/unavailable', name: 'unavailable', component: empty },
        { path: '/fine', name: 'fine', component: () => Promise.resolve(empty) },
        { path: '/broken', name: 'broken', component: () => Promise.reject(new Error('404')) },
      ],
    })
    router.beforeEach((to) =>
      to.name === 'unavailable' || reachable
        ? true
        : { name: 'unavailable', query: { next: to.fullPath } },
    )
    // 注册之后 vue-router 不再把错误打到控制台，用例的输出干净一点
    router.onError(() => {})
    await router.push('/unavailable')
    return router
  }

  it('连上了就离开这一页', async () => {
    const router = await routerFor(true)
    expect(await retryNavigation(router, '/fine')).toBe('recovered')
    expect(router.currentRoute.value.name).toBe('fine')
  })

  it('还是连不上：守卫转回这一页，导航不报错，也要算没成功', async () => {
    const router = await routerFor(false)
    expect(await retryNavigation(router, '/fine')).toBe('unreachable')
    expect(router.currentRoute.value.name).toBe('unavailable')
  })

  it('接口通了、页面文件加载不到：导航 reject，要接住并算没成功', async () => {
    const router = await routerFor(true)
    expect(await retryNavigation(router, '/broken')).toBe('assets')
    expect(router.currentRoute.value.name).toBe('unavailable')
  })
})

describe('登录页的地层', () => {
  const strataOf = (html: string) => /<div class="entry-strata".*?<\/div>/s.exec(html)![0]

  it('文字标、内容和一段地层都在', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    expect(html).toContain('aria-label="記憶"')
    expect(html).toContain('表单')
    expect(strataOf(html)).toContain('var(--layer-user)')
  })

  it('只铺归属色，不铺纹理：纹理表示敏感级，这里没有数据', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    expect(html).not.toContain('<pattern')
    expect(html).not.toContain('url(#')
    expect(entryFrame).not.toContain('StrataPatterns')
    expect(entryFrame).not.toContain('paintCell')
  })

  it('只是装饰，读屏不读', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    expect(/<div class="entry-strata"[^>]*>/.exec(html)![0]).toContain('aria-hidden="true"')
  })

  it('纵向顺序和地层柱一样，六类铺满，来自对话的两类用虚线隔开', async () => {
    const strata = strataOf(await render(EntryFrame, {}, { default: () => '表单' }))
    const bands = [...strata.matchAll(/<i([^>]*)>/g)].map((m) => m[1]!)
    expect(bands.map((band) => /--layer-(\w+)/.exec(band)![1])).toEqual([...STACK])
    const heights = bands.map((band) => Number(/flex-grow:(\d+)/.exec(band)![1]))
    expect(heights.reduce((a, b) => a + b, 0)).toBe(100)
    // 虚线只有一条，在联系人和本人之间
    expect(bands.map((band) => band.includes('dashed'))).toEqual(
      STACK.map((layer) => layer === 'user'),
    )
  })

  it('不固定在视口上：窗口很矮或键盘弹出时不盖住表单', () => {
    const style = parse(entryFrame).descriptor.styles[0]!.content
    expect(/\.entry-strata \{[^}]*\}/.exec(style)![0]).not.toContain('position')
  })
})
