import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import consoleLayout from '../layouts/ConsoleLayout.vue?raw'

// 没有组件测试的环境，所以看源码本身：外壳改过长相，这些逻辑不能跟着丢
const { descriptor } = parse(consoleLayout)
const script = descriptor.scriptSetup?.content ?? ''
const template = descriptor.template?.content ?? ''

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
    expect(template).toContain('<USlideover')
    expect(template).toContain('max-[901px]:hidden')
    expect(template).toContain('min-[901px]:hidden')
    expect(template).not.toContain('max-[900px]')
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

  it('全站的纹理定义在外壳里挂一次', () => {
    expect(template.match(/<StrataPatterns/g)).toHaveLength(1)
  })

  it('主题用 Nuxt UI 的 color mode，不另存一份', () => {
    expect(script).toContain('useColorPreference()')
    expect(script).not.toContain('localStorage')
  })
})
