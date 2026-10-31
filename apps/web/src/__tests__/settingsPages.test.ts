import { SetupRequest } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, h, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import backupSettings from '../components/BackupSettings.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import embeddingChannelRow from '../components/EmbeddingChannelRow.vue?raw'
import embeddingSettings from '../components/EmbeddingSettings.vue?raw'
import extractionBudget from '../components/ExtractionBudget.vue?raw'
import extractionSettings from '../components/ExtractionSettings.vue?raw'
import loreImport from '../components/LoreImport.vue?raw'
import myDreamSettings from '../components/MyDreamSettings.vue?raw'
import retentionSettings from '../components/RetentionSettings.vue?raw'
import spaceExport from '../components/SpaceExport.vue?raw'
import spaceImport from '../components/SpaceImport.vue?raw'
import EntryFrame from '../components/strata/EntryFrame.vue'
import entryFrame from '../components/strata/EntryFrame.vue?raw'
import SettingsBlock from '../components/strata/SettingsBlock.vue'
import SettingsFrame from '../components/strata/SettingsFrame.vue'
import settingsFrame from '../components/strata/SettingsFrame.vue?raw'
import { STACK } from '../components/strata/strata'
import homePage from '../pages/HomePage.vue?raw'
import loginPage from '../pages/LoginPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'
import settingsPage from '../pages/SettingsPage.vue?raw'
import setupPage from '../pages/SetupPage.vue?raw'
import spaceSettingsPage from '../pages/SpaceSettingsPage.vue?raw'
import unavailablePage from '../pages/UnavailablePage.vue?raw'
import routesSource from '../routes.ts?raw'
import {
  currentSection,
  INSTANCE_SECTIONS,
  instanceSettingsRoute,
  sectionQuery,
  SPACE_SECTIONS,
  spaceSettingsRoute,
} from '../settingsSections'

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
  slots: Record<string, () => unknown> = {},
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
  SettingsPage: settingsPage,
  SpaceSettingsPage: spaceSettingsPage,
}

describe('小节记在地址里', () => {
  it('地址里写了存在的小节就看它，其余看第一节', () => {
    expect(currentSection(SPACE_SECTIONS, 'lore')).toBe('lore')
    expect(currentSection(SPACE_SECTIONS, undefined)).toBe('layers')
    expect(currentSection(SPACE_SECTIONS, 'nonsense')).toBe('layers')
    expect(currentSection(SPACE_SECTIONS, ['lore'])).toBe('layers')
    expect(currentSection(INSTANCE_SECTIONS, 'master-key')).toBe('master-key')
  })

  it('第一节是默认的，不写进地址', () => {
    expect(sectionQuery(INSTANCE_SECTIONS, 'embedding')).toEqual({})
    expect(sectionQuery(INSTANCE_SECTIONS, 'backup')).toEqual({ section: 'backup' })
  })

  it('别的页面链到具体的小节：调整预算不用再自己找', () => {
    expect(spaceSettingsRoute('s1', 'budget')).toEqual({
      name: 'space-settings',
      params: { spaceId: 's1' },
      query: { section: 'budget' },
    })
    expect(instanceSettingsRoute('backup')).toEqual({
      name: 'settings',
      query: { section: 'backup' },
    })
    expect(overviewPage).toContain(`:to="spaceSettingsRoute(spaceId, 'budget')"`)
    expect(overviewPage).toContain(`:to="instanceSettingsRoute('backup')"`)
    expect(dreamSuggestions).toContain(`:to="spaceSettingsRoute(spaceId, 'dream')"`)
  })
})

describe('设置页的骨架', () => {
  const frame = (url: string, unsaved: string[] = []) =>
    render(
      SettingsFrame,
      { title: '空间设置', sections: SPACE_SECTIONS, unsaved },
      Object.fromEntries(SPACE_SECTIONS.map((s) => [s.key, () => `内容 ${s.key}`])),
      url,
    )
  // 渲染结果里一个小节的 section 标签
  const sectionTag = (html: string, label: string) =>
    new RegExp(`<section[^>]*aria-label="${label}"[^>]*>`).exec(html)![0]
  const currentLinks = (html: string) => [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>/g)]

  it('所有小节一直挂着，只显示当前这一节', async () => {
    const html = await frame('/?section=budget')
    for (const section of SPACE_SECTIONS) expect(html).toContain(`内容 ${section.key}`)
    expect(sectionTag(html, '抽取预算')).not.toContain('display:none')
    expect(sectionTag(html, 'domain 默认层')).toContain('display:none')
    expect(sectionTag(html, '从 Lore 导入')).toContain('display:none')
  })

  it('模板里用 v-show 不用 v-if：切走再回来，填了一半的表单还在', () => {
    const section = elementsOf(template(settingsFrame)).find((el) => el.tag === 'section')!
    expect(directive(section, 'show')?.exp?.content).toBe('section.key === current')
    expect(directive(section, 'if')).toBeUndefined()
  })

  it('子导航标出当前小节，地址不对时是第一节', async () => {
    const budget = currentLinks(await frame('/?section=budget'))
    expect(budget).toHaveLength(1)
    expect(budget[0]![0]).toContain('section=budget')
    const fallback = currentLinks(await frame('/?section=nonsense'))
    expect(fallback).toHaveLength(1)
    expect(fallback[0]![0]).not.toContain('section=')
  })

  it('切小节不留历史记录，返回键直接离开设置页', () => {
    const link = elementsOf(template(settingsFrame)).find((el) => el.tag === 'RouterLink')!
    expect(link.props?.some((p) => p.name === 'replace')).toBe(true)
    expect(bound(link, 'to')).toBe('{ query: sectionQuery(sections, section.key) }')
  })

  it('有未保存改动的小节在子导航上标出来', async () => {
    const html = await frame('/', ['budget'])
    const tabs = [...html.matchAll(/<a[^>]*>.*?<\/a>/g)].map((m) => m[0])
    expect(
      tabs.filter((tab) => tab.includes('未保存')).map((tab) => tab.includes('抽取预算')),
    ).toEqual([true])
  })

  it('切换时记下滚动位置，当前小节滚进子导航的可见范围', () => {
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

describe('两个设置页', () => {
  const slotsOf = (source: string) =>
    (template(source).children ?? [])
      .flatMap((n) => n.children ?? [])
      .filter((n) => n.type === ELEMENT && n.tag === 'template')
      .map((n) => directive(n, 'slot')?.arg?.content)

  it('每个小节都有内容，顺序和子导航一样', () => {
    expect(slotsOf(settingsPage)).toEqual(INSTANCE_SECTIONS.map((s) => s.key))
    expect(slotsOf(spaceSettingsPage)).toEqual(SPACE_SECTIONS.map((s) => s.key))
  })

  it('页面都换成了新骨架', () => {
    for (const [name, source] of Object.entries(settingsSources)) {
      for (const old of ['UDashboardPanel', 'UDashboardNavbar', '<UCard', '<UAlert', '<UBadge']) {
        expect(source, `${name} ${old}`).not.toContain(old)
      }
    }
    expect(settingsPage).toContain('<SettingsFrame')
    expect(spaceSettingsPage).toContain('<SettingsFrame')
    expect(homePage).not.toContain('UDashboardPanel')
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

  it('空间设置只注册一份未保存确认，切小节不算离开，换空间算', () => {
    const script = scriptOf(spaceSettingsPage)
    expect(script.match(/useUnsavedChangesGuard\(/g)).toHaveLength(1)
    expect(script).toContain('dirty.value || budgetDirty.value')
    expect(script).toContain('leavesOn: (to, from) => to.params.spaceId !== from.params.spaceId')
    for (const [name, source] of Object.entries(settingsSources)) {
      if (name === 'SpaceSettingsPage') continue
      expect(source, name).not.toContain('useUnsavedChangesGuard(')
    }
  })

  it('预算的改动还报给页面', () => {
    const budget = elementsOf(template(spaceSettingsPage)).find(
      (el) => el.tag === 'ExtractionBudget',
    )!
    expect(directive(budget, 'model')?.arg?.content).toBe('dirty')
    expect(directive(budget, 'model')?.exp?.content).toBe('budgetDirty')
    expect(extractionBudget).toContain('watch(dirty, (d) => (dirtyModel.value = d)')
  })

  it('实例设置的表单把改动报给页面，切走之后子导航上看得到', () => {
    const elements = elementsOf(template(settingsPage))
    for (const [tag, key] of [
      ['EmbeddingSettings', 'embedding'],
      ['ExtractionSettings', 'extraction'],
      ['BackupSettings', 'backup'],
      ['RetentionSettings', 'retention'],
    ] as const) {
      const el = elements.find((e) => e.tag === tag)!
      expect(directive(el, 'model')?.exp?.content, tag).toBe(`dirty.${key}`)
    }
    expect(embeddingSettings).toContain('(dirtyModel.value = a || n)')
    expect(extractionSettings).toContain('dirtyModel.value = changed')
    expect(backupSettings).toContain('dirtyModel.value = changed')
    expect(retentionSettings).toContain('(changed) => (dirtyModel.value = changed)')
    expect(scriptOf(settingsPage)).toContain("...(recallDirty.value ? ['recall'] : [])")
  })

  it('回车提交还在：每个表单提交到原来的处理函数，都有提交按钮', () => {
    const forms: [string, string, string][] = [
      ['SettingsPage', settingsPage, 'saveRetention'],
      ['EmbeddingSettings', embeddingSettings, 'saveActive'],
      ['EmbeddingSettings', embeddingSettings, 'saveNext'],
      ['EmbeddingSettings', embeddingSettings, 'askStart'],
      ['ExtractionSettings', extractionSettings, 'save'],
      ['ExtractionBudget', extractionBudget, 'save'],
      ['BackupSettings', backupSettings, 'save'],
      ['RetentionSettings', retentionSettings, 'save'],
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
  })

  it('一页只有一个实心按钮，砖红只给破坏性操作', () => {
    for (const [name, source] of Object.entries(settingsSources)) {
      const buttons = buttonsOutsideModals(template(source))
      const solid = buttons.filter((b) => !attr(b, 'variant'))
      expect(
        solid.map(textOf).filter((t) => t !== '确认导入'),
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

  it('渠道不再是圆角卡片，用线分开', () => {
    expect(embeddingChannelRow).not.toContain('rounded-md')
    expect(embeddingChannelRow).toContain('border-t border-default')
  })
})

describe('读取失败', () => {
  // [文件, 查询, 错误之后内容的显示条件：读到过就照常显示。null 表示不看读取结果，一直显示]
  const reads: [string, string, string, string | null][] = [
    ['SettingsPage', settingsPage, 'masterKey', 'masterKey.data.value'],
    [
      'SettingsPage',
      settingsPage,
      'recallSettings',
      '!recallSettings.isError.value || recallSettings.data.value',
    ],
    ['EmbeddingSettings', embeddingSettings, 'settings', null],
    ['EmbeddingSettings', embeddingSettings, 'status', 'status.data.value'],
    [
      'ExtractionSettings',
      extractionSettings,
      'settings',
      '!settings.isError.value || settings.data.value',
    ],
    ['BackupSettings', backupSettings, 'settings', '!settings.isError.value || view'],
    ['RetentionSettings', retentionSettings, 'settings', 'view'],
    ['ExtractionBudget', extractionBudget, 'usage', null],
    ['MyDreamSettings', myDreamSettings, 'settings', null],
    [
      'SpaceSettingsPage',
      spaceSettingsPage,
      'layers',
      '!layers.isError.value || baseline !== null',
    ],
    ['BackupSettings', backupSettings, 'objects', null],
  ]

  it.each(reads)('%s 的 %s：错误放在上面，读到过的内容留着', (name, source, query, shown) => {
    const expression = `${query}.isError.value`
    const siblings = elementsOf(template(source)).find((el) =>
      (el.children ?? []).some((c) => c.tag === 'NoteLine' && condition(c) === expression),
    )?.children
    const list = siblings ?? template(source).children ?? []
    const elementsAfter = list.filter((n) => n.type === ELEMENT)
    const index = elementsAfter.findIndex(
      (c) => c.tag === 'NoteLine' && condition(c) === expression,
    )
    expect(index, `${name} ${query}`).toBeGreaterThanOrEqual(0)
    // 错误和内容不是二选一
    const next = elementsAfter[index + 1]
    expect(directive(next!, 'else'), name).toBeUndefined()
    expect(directive(next!, 'else-if'), name).toBeUndefined()
    if (shown) expect(condition(next!), `${name} ${query}`).toBe(shown)
  })

  it('嵌入模型没读到过设置时不给表单：空表单保存会盖掉读不到的那份', () => {
    const form = elementsOf(template(embeddingSettings)).find(
      (el) => el.tag === 'form' && handler(el, 'submit') === 'saveActive',
    )!
    expect(condition(form)).toBe('!settings.isError.value || settings.data.value')
  })

  it('错误文字：服务端给了说明就用它', () => {
    for (const [name, source] of Object.entries(settingsSources)) {
      if (!source.includes('isError')) continue
      expect(source, name).not.toMatch(/isError\.value && !/)
    }
    expect(backupSettings).toContain("objects.error.value.message : '无法列出备份'")
    expect(embeddingSettings).toContain("settings.error.value.message : '读取设置失败'")
  })

  it('「暂无」只在真的读到空时显示', () => {
    expect(
      condition(elementsOf(template(backupSettings)).find((el) => textOf(el) === '暂无备份')!),
    ).toBe('objects.data.value && !objects.data.value.objects.length')
    expect(
      condition(
        elementsOf(template(spaceSettingsPage)).find((el) => textOf(el).startsWith('暂无配置'))!,
      ),
    ).toBe('baseline !== null && !rows.length')
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

describe('没有权限时', () => {
  it('小节都在，内容和改版前一样收起', () => {
    const ownerOnly = (source: string, text: string) =>
      elementsOf(template(source)).find((el) => textOf(el) === text)
    expect(condition(ownerOnly(spaceSettingsPage, '仅空间所有者可修改')!)).toBe('!isOwner')
    expect(condition(ownerOnly(spaceExport, '仅空间所有者可导出')!)).toBe('!editable')
    expect(condition(ownerOnly(loreImport, '仅空间所有者可导入')!)).toBe('!editable')
    expect(flat(extractionBudget)).toContain('仅空间所有者可修改预算')
    const budgetForm = elementsOf(template(extractionBudget)).find((el) => el.tag === 'form')!
    expect(condition(budgetForm)).toBe('editable')
  })

  it('domain 默认层：不是所有者时输入框禁用、没有增删和保存', () => {
    const elements = elementsOf(template(spaceSettingsPage))
    expect(
      bound(
        elements.find((el) => el.tag === 'UInput')!,
        'disabled',
      ),
    ).toBe('!editable')
    expect(
      bound(
        elements.find((el) => el.tag === 'USelect')!,
        'disabled',
      ),
    ).toBe('!editable')
    expect(condition(elements.find((el) => attr(el, 'aria-label') === '删除此行')!)).toBe('isOwner')
    const save = elements.find((el) => el.tag === 'UButton' && textOf(el) === '保存')!
    expect(bound(save, 'disabled')).toBe('!dirty || !!problem')
    expect(scriptOf(spaceSettingsPage)).toContain(
      'isOwner.value && baseline.value !== null && !saving.value',
    )
  })

  it('空间设置把权限传给各小节', () => {
    const elements = elementsOf(template(spaceSettingsPage))
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
    expect(routesSource).toMatch(/name: 'settings',[^}]*meta: \{ requiresAdmin: true \}/)
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
    [
      'Dream',
      myDreamSettings,
      '开启后，当前账号的个人画像层与私人层（机密除外）将发送给抽取模型整理，已发送的内容无法撤回。',
    ],
    ['导出口令', spaceExport, 'Kioku不保存口令，丢失后无法打开文件。'],
    ['导出的口令提示', spaceExport, '请另行保存口令。Kioku不保存口令，丢失后无法打开此文件。'],
    ['导入空间', spaceImport, '仅导入本人导出、或导出人同意移交的文件。'],
    [
      '导入空间的归属',
      spaceImport,
      '个人画像层将进入当前账号Agent的启动加载。仅导入本人导出、或导出人同意移交的文件。',
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
    ['Lore 明文 Token', loreImport, 'Token将明文传输，而此Token可清空整个Lore。请尽量改用https。'],
    ['Lore 已导入的机密', loreImport, '此前已导入，当前仍为明文，本次标记的机密未生效。'],
    ['主密钥', settingsPage, '未配置主密钥，无法保存机密记忆、托管的凭据与接口Key。'],
    [
      '轮换完成',
      settingsPage,
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

  it('按服务端同一个规则校验，字段的提示都在', () => {
    const form = elements.find((el) => el.tag === 'UForm')!
    expect(bound(form, 'schema')).toBe('SetupRequest')
    expect(handler(form, 'submit')).toBe('submit')
    expect(elements.filter((el) => el.tag === 'UFormField').map((el) => attr(el, 'name'))).toEqual([
      'username',
      'displayName',
      'password',
      'spaceName',
    ])
    expect(elements.filter((el) => attr(el, 'type') === 'submit').map(textOf)).toEqual([
      '创建并登录',
    ])
    expect(flat(setupPage)).toContain('创建首个账号及其空间，该账号为实例管理员。')
  })

  it('校验的提示是中文：这是装好之后看到的第一屏', () => {
    const issues = SetupRequest.safeParse({
      username: 'lin',
      displayName: '',
      password: 'long-enough-password',
      spaceName: '',
    }).error!.issues
    expect(issues.map((issue) => issue.message)).toEqual(['请填写显示名', '请填写空间名'])
    const tooLong = 'x'.repeat(65)
    const long = SetupRequest.safeParse({
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

  it('只回到站内路径', () => {
    expect(script).toContain(
      "typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')",
    )
  })

  it('重试有反馈：转圈，还是连不上时说一声', () => {
    expect(script).toContain("if (route.name === 'unavailable') failedAt.value")
    const button = elementsOf(template(unavailablePage)).find((el) => el.tag === 'UButton')!
    expect(bound(button, 'loading')).toBe('retrying')
    expect(handler(button, 'click')).toBe('retry')
    const note = elementsOf(template(unavailablePage)).find((el) => condition(el) === 'failedAt')!
    expect(attr(note, 'role')).toBe('status')
  })
})

describe('登录页的地层', () => {
  it('文字标、内容和一段地层都在，纹理定义也带上', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    expect(html).toContain('aria-label="記憶"')
    expect(html).toContain('表单')
    expect(html).toContain('<pattern')
    expect(html).toContain('url(#strata-lines-lg)')
    expect(html).toContain('url(#strata-dots-lg)')
  })

  it('只是装饰，读屏不读', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    expect(/<svg class="entry-strata"[^>]*>/.exec(html)![0]).toContain('aria-hidden="true"')
  })

  it('纵向顺序和地层柱一样，七层铺满，来自对话的两层用虚线隔开', async () => {
    const html = await render(EntryFrame, {}, { default: () => '表单' })
    const strata = /<svg class="entry-strata".*?<\/svg>/s.exec(html)![0]
    const layers = [...strata.matchAll(/fill:var\(--layer-(\w+)\)/g)].map((m) => m[1])
    expect(layers).toEqual([...STACK])
    const heights = [...strata.matchAll(/<rect[^>]*height="(\d+)%"[^>]*fill:var\(--layer/g)].map(
      (m) => Number(m[1]),
    )
    expect(heights.reduce((a, b) => a + b, 0)).toBe(100)
    expect(strata.match(/stroke-dasharray/g)).toHaveLength(1)
  })

  it('不固定在视口上：窗口很矮或键盘弹出时不盖住表单', () => {
    const style = parse(entryFrame).descriptor.styles[0]!.content
    expect(/\.entry-strata \{[^}]*\}/.exec(style)![0]).not.toContain('position')
  })
})
