import type { ActivityItem } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import ActivityEntry from '../components/ActivityEntry.vue'
import activityEntry from '../components/ActivityEntry.vue?raw'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import personaDetail from '../components/PersonaDetail.vue?raw'
import MemoryRow from '../components/strata/MemoryRow.vue'
import PageHead from '../components/strata/PageHead.vue'
import activityPage from '../pages/ActivityPage.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import personasPage from '../pages/PersonasPage.vue?raw'
import subjectDetailPage from '../pages/SubjectDetailPage.vue?raw'
import subjectsPage from '../pages/SubjectsPage.vue?raw'

// 人格、联系人、凭据、变更记录。长相改过，确认框的后果和值不进缓存这些约束不能跟着丢

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: { name: string; arg?: { content: string }; exp?: { content: string } }[]
}
const ELEMENT = 1
const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const tagsOf = (source: string) => elementsOf(template(source)).map((el) => el.tag)
// 从根走到第一个这种标签，路上经过了哪些标签
function pathTo(node: TemplateNode, tag: string, path: string[] = []): string[] | null {
  if (node.type === ELEMENT && node.tag === tag) return path
  for (const child of node.children ?? []) {
    const found = pathTo(child, tag, node.tag ? [...path, node.tag] : path)
    if (found) return found
  }
  return null
}
const bound = (source: string, tag: string, name: string) =>
  elementsOf(template(source))
    .filter((el) => el.tag === tag)
    .flatMap((el) => el.props ?? [])
    .find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content

// 没有路由，RouterLink 换成一个普通的 a，属性照样落上去
const render = (component: Component, props: Record<string, unknown>, slots = {}) => {
  const app = createSSRApp({ render: () => h(component, props, slots) })
  app.component(
    'RouterLink',
    defineComponent({
      setup:
        (_, { slots: inner }) =>
        () =>
          h('a', inner.default?.()),
    }),
  )
  return renderToString(app)
}

describe('变更记录的一行', () => {
  const item = (changes: Partial<ActivityItem> = {}): ActivityItem => ({
    id: 1,
    type: 'update',
    memoryId: '00000000-0000-4000-8000-000000000000',
    uri: 'projects://atlas/release',
    createdAt: new Date(2026, 9, 31, 7, 5).toISOString(),
    actor: { accountName: null, keyName: 'MacBook', appName: 'Claude Code' },
    changes: ['content', 'priority'],
    left: false,
    deleted: false,
    expired: false,
    bench: null,
    ...changes,
  })
  const entry = (changes: Partial<ActivityItem> = {}) =>
    render(ActivityEntry, { item: item(changes), spaceId: 'space' })

  it('谁、动作、URI、字段、时间都在一行里', async () => {
    const html = await entry()
    expect(html).toContain('Claude Code（MacBook）')
    expect(html).toContain('修改')
    expect(html).toContain('projects://atlas/')
    expect(html).toContain('release')
    expect(html).toContain('正文、优先级')
    expect(html).toContain('07:05')
  })

  it('记忆还在才能点过去：已删除、已过期、超出可见范围的 URI 上可能是别的记忆', async () => {
    expect(await entry()).toContain('<a')
    for (const state of [{ left: true }, { deleted: true }, { expired: true }]) {
      expect(await entry(state)).not.toContain('<a')
    }
  })

  it('已删除的不再标已过期', async () => {
    expect(await entry({ expired: true })).toContain('已过期')
    expect(await entry({ expired: true, deleted: true })).not.toContain('已过期')
  })

  it('超出可见范围的后果留在提示层里', async () => {
    expect(await entry({ left: true, changes: [] })).toContain('超出可见范围')
    expect(await entry()).not.toContain('超出可见范围')
    expect(activityEntry).toContain('这条记忆超出当前账号的可见范围（例如改入其他成员的私人层')
  })

  it('测试台写下的事件标出测试台和操作账号', async () => {
    const html = await entry({ bench: { accountName: '林默', run: 'abcd1234' } })
    expect(html).toContain('测试台')
    expect(html).toContain('操作账号：林默')
    expect(html).toContain('运行标记 abcd1234')
    expect(await entry({ bench: { accountName: null, run: 'abcd1234' } })).toContain(
      '操作账号：已删除的账号',
    )
    expect(await entry()).not.toContain('测试台')
  })
})

describe('记忆的一行', () => {
  const props = { uri: 'persona://a/soul', layer: 'persona', sensitivity: 'internal' }

  it('给了 to 时 URI 是链接，没给时不是', async () => {
    const linked = await render(MemoryRow, { ...props, to: '/somewhere' })
    expect(linked).toContain('<a')
    expect(linked).toContain('linked')
    const plain = await render(MemoryRow, props)
    expect(plain).not.toContain('<a')
    expect(plain).not.toContain('linked')
  })

  it('flags 插槽换掉默认的标记', async () => {
    const normal = await render(MemoryRow, { ...props, priority: 0 })
    expect(normal).toContain('memory-flags')
    const replaced = await render(
      MemoryRow,
      { ...props, priority: 0 },
      { flags: () => h('b', '换上的标记') },
    )
    expect(replaced).not.toContain('memory-flags')
    expect(replaced).toContain('换上的标记')
  })

  it('flush 去掉左右边距，默认不去', async () => {
    expect(await render(MemoryRow, { ...props, flush: true })).toContain('flush')
    expect(await render(MemoryRow, props)).not.toContain('flush')
  })
})

describe('页面标题', () => {
  it('说明和操作都可以没有', async () => {
    const bare = await render(PageHead, { title: '凭据' })
    expect(bare).toContain('<h1')
    expect(bare).not.toContain('<p')
    expect(bare).not.toContain('page-actions')
    const full = await render(
      PageHead,
      { title: '凭据' },
      { note: () => '说明', actions: () => h('button', '新建') },
    )
    expect(full).toContain('说明')
    expect(full).toContain('page-actions')
  })

  it('标题旁的提示不占说明那一行', async () => {
    const html = await render(PageHead, { title: '变更记录' }, { hint: () => h('button', '提示') })
    expect(html).toContain('提示')
    expect(html).not.toContain('<p')
  })
})

describe('改版之后的约束', () => {
  it.each([
    ['人格页', personasPage],
    ['人格详情', personaDetail],
    ['联系人页', subjectsPage],
    ['联系人详情', subjectDetailPage],
    ['凭据页', credentialsPage],
    ['凭据详情', credentialDetail],
    ['变更记录页', activityPage],
    ['变更记录的一行', activityEntry],
  ])('%s不用彩色徽章、卡片和老外壳', (_name, source) => {
    const tags = tagsOf(source)
    for (const old of ['UBadge', 'UCard', 'UAlert', 'UDashboardPanel', 'UDashboardNavbar']) {
      expect(tags).not.toContain(old)
    }
  })

  it('人格：有引用时不能删，原因和缺失启动加载的提示都在', () => {
    expect(bound(personaDetail, 'UButton', 'disabled')).toBe('blockers.length > 0')
    expect(personaDetail).toContain('无法删除：')
    expect(personaDetail).toContain('此节点本应进入启动加载')
    expect(personaDetail).toContain('会话开始时此路径将缺失')
    expect(personasPage).toContain('可用于新人格')
  })

  it('人格：窄屏切换后焦点不掉到 body', () => {
    expect(personasPage).toContain('focusAfterSelect(narrow.value, id, previous)')
    expect(personasPage).toMatch(/ref="detailColumn"[^>]*tabindex="-1"/)
  })

  it('联系人：绑定组件知道自己在哪个联系人页，确认后才能换到保留的那个', () => {
    expect(bound(subjectDetailPage, 'SubjectBindings', 'subject-id')).toBe('subjectId')
    // 绑定只有人有
    expect(pathTo(template(subjectDetailPage), 'SubjectBindings')).toContain('section')
    expect(subjectDetailPage).toMatch(
      /<section v-if="data\.kind === 'person'">\s*<SectionHeading title="账号绑定">/,
    )
  })

  it('联系人：合并的确认框写明后果，按人和群分开说', () => {
    expect(subjectDetailPage).toContain('此操作不可撤销')
    expect(subjectDetailPage).toContain('v-if="data?.kind === \'group\'"')
    expect(subjectDetailPage).toContain('按群切换人格的规则一并转移')
    expect(subjectDetailPage).toContain('合并后这些平台账号算同一个人')
    expect(subjectDetailPage).toContain('不再注入对话，也无法在管理界面恢复')
  })

  it('联系人：人和群各翻各的页，查询的键还在 subjects 下面，改动之后跟着失效', () => {
    expect(subjectsPage).toContain("['subjects', spaceId.value, kind, q.value]")
  })

  it('凭据：值只放在详情组件里，不进查询缓存；关掉面板就卸载', () => {
    expect(credentialDetail).not.toContain('setQueryData')
    expect(credentialDetail).toContain('onBeforeUnmount(() => (revealed.value = null))')
    const path = pathTo(template(credentialsPage), 'CredentialDetail')
    expect(path).toContain('USlideover')
    expect(credentialDetail).toContain('并记录一次访问')
  })

  it('凭据：删除与恢复的说明都在', () => {
    expect(credentialsPage).toContain('引用它的占位符将无法取值')
    expect(credentialsPage).toContain('曾绑定它的已删除凭据恢复后需重新绑定')
    expect(credentialsPage).toContain('已删除的凭据源无法恢复')
    expect(credentialsPage).toContain('deletionNotice(retention)')
  })
})
