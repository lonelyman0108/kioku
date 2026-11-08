import type { ActivityItem } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import ActivityEntry from '../components/ActivityEntry.vue'
import activityEntry from '../components/ActivityEntry.vue?raw'
import activityFlags from '../components/ActivityFlags.vue?raw'
import RecentChange from '../components/RecentChange.vue'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import credentialFormModal from '../components/CredentialFormModal.vue?raw'
import deletedMemories from '../components/DeletedMemories.vue?raw'
import expiredMemories from '../components/ExpiredMemories.vue?raw'
import memoryListView from '../components/MemoryListView.vue?raw'
import memoryRootPanel from '../components/MemoryRootPanel.vue?raw'
import personaDetail from '../components/PersonaDetail.vue?raw'
import personaPanel from '../components/PersonaPanel.vue?raw'
import MemoryRow from '../components/strata/MemoryRow.vue'
import PageHead from '../components/strata/PageHead.vue'
import activityPage from '../pages/ActivityPage.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import subjectsPage from '../components/ContactList.vue?raw'
import subjectDetailPage from '../pages/ContactDetailPage.vue?raw'
import vaultConnectionPanel from '../components/VaultConnectionPanel.vue?raw'
import vaultLoginModal from '../components/VaultLoginModal.vue?raw'

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
    uri: 'user://projects/atlas/release',
    title: '发布步骤',
    layer: 'user',
    sensitivity: 'private',
    createdAt: new Date(2026, 9, 31, 7, 5).toISOString(),
    actor: { accountName: null, keyName: 'MacBook', appName: 'Claude Code' },
    actorKey: 'app:00000000-0000-4000-8000-000000000001',
    changes: ['content', 'priority'],
    fieldChanges: [
      { field: 'content', added: 2, removed: 1 },
      { field: 'priority', before: 1, after: 0 },
    ],
    versionBefore: 1,
    versionAfter: 2,
    left: false,
    deleted: false,
    expired: false,
    bench: null,
    ...changes,
  })
  const entry = (changes: Partial<ActivityItem> = {}, props: Record<string, unknown> = {}) =>
    render(ActivityEntry, { item: item(changes), ...props })
  const recent = (changes: Partial<ActivityItem> = {}) =>
    render(RecentChange, { item: item(changes), spaceId: 'space' })

  it('时间、操作者、操作、标题、改动各占一列，坐标与访问密钥放在悬停里', async () => {
    const html = await entry()
    expect(html).toContain('Claude Code')
    expect(html).toContain('title="Claude Code，访问密钥：MacBook"')
    expect(html).toContain('修改')
    expect(html).toContain('>发布步骤</span>')
    expect(html).toContain('title="发布步骤\nuser://projects/atlas/release"')
    expect(html).toMatch(/正文<em[^>]*>\+2 −1<\/em>/)
    expect(html).toMatch(/优先级<em[^>]*>1 → 0<\/em>/)
    expect(html).toContain('07:05')
    expect((html.match(/<td/g) ?? []).length).toBe(6)
  })

  it('详情打开时没有状态列，状态并进记忆那一列；窄屏只有时间与记忆两列', async () => {
    const compact = await entry({ deleted: true }, { layout: 'compact' })
    expect((compact.match(/<td/g) ?? []).length).toBe(5)
    expect(compact).toContain('已删除')
    const narrow = await entry({}, { layout: 'narrow' })
    expect((narrow.match(/<td/g) ?? []).length).toBe(2)
    expect(narrow).toContain('正文 +2 −1、优先级 1 → 0')
  })

  it('折起来的几次修改写成 ×N，能展开', async () => {
    expect(await entry({}, { folded: 2 })).toContain('×3')
    expect(await entry({}, { folded: 2 })).toContain('aria-label="展开 3 次修改"')
    expect(await entry()).not.toContain('×')
  })

  it('机密带锁；离开的没有改动', async () => {
    expect(await entry({ sensitivity: 'secret' })).toContain('aria-label="机密"')
    const left = await entry({ left: true, changes: [], fieldChanges: [] })
    expect(left).toContain('超出可见范围')
    expect(left).not.toContain('正文')
  })

  it('概览的最近变更：记忆还在才能点过去，已删除、已过期、超出可见范围的 URI 上可能是别的记忆', async () => {
    expect(await recent()).toContain('<a')
    for (const state of [{ left: true }, { deleted: true }, { expired: true }]) {
      expect(await recent(state)).not.toContain('<a')
    }
  })

  it('已删除的不再标已过期', async () => {
    expect(await entry({ expired: true })).toContain('已过期')
    expect(await entry({ expired: true, deleted: true })).not.toContain('已过期')
  })

  it('超出可见范围的后果留在提示层里', async () => {
    expect(await entry({ left: true, changes: [], fieldChanges: [] })).toContain('超出可见范围')
    expect(await entry()).not.toContain('超出可见范围')
    expect(activityFlags).toContain('这条记忆超出当前账号的可见范围（例如移入其他成员的本人记忆')
  })

  it('测试台写下的事件标出测试台和操作账号', async () => {
    const bench = { bench: { accountName: '林默', run: 'abcd1234' }, actorKey: 'bench' }
    const html = await entry(bench)
    expect(html).toContain('测试台 · 林默')
    expect(html).toContain('操作账号：林默')
    expect(html).toContain('运行标记 abcd1234')
    expect(
      await entry({ bench: { accountName: null, run: 'abcd1234' }, actorKey: 'bench' }),
    ).toContain('操作账号：已删除的账号')
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

describe('列表读取失败', () => {
  it.each([
    ['变更记录', activityPage, 'activity'],
    ['联系人', subjectsPage, 'section.query'],
    ['列表', memoryListView, 'list'],
    ['已过期', expiredMemories, 'expired'],
    ['已删除', deletedMemories, 'deleted'],
  ])('%s：读取失败时已读到的行留着，翻页失败的错误靠着「加载更多」', (_, source, query) => {
    const markup = source.slice(source.indexOf('<template>'))
    const above = markup.indexOf(`${query}.isError.value && !${query}.isFetchNextPageError.value`)
    const rows = markup.indexOf(`v-else-if="${query}.data.value"`)
    const below = markup.indexOf(`v-if="${query}.isFetchNextPageError.value"`)
    expect(above).toBeGreaterThan(-1)
    expect(rows).toBeGreaterThan(above)
    expect(below).toBeGreaterThan(rows)
    expect(markup.indexOf(`${query}.fetchNextPage()`)).toBeGreaterThan(below)
    expect(markup).toContain(`v-if="${query}.isPending.value"`)
  })

  it.each([
    ['人格', memoryRootPanel, 'personas'],
    ['凭据', credentialsPage, 'credentials'],
    ['已删除的凭据', credentialsPage, 'deleted'],
  ])('%s：错误和读到过的列表可以同时显示，没读到时不说是空的', (_, source, query) => {
    expect(source).toContain(`v-if="${query}.isError.value"`)
    expect(source).toContain(`v-if="${query}.isPending.value"`)
    expect(source).toMatch(new RegExp(`v-else-if="${query}\\.data\\.value" class="[\\w-]*empty"`))
  })

  it('凭据详情的引用和记录读取失败时能重试，不显示成空', () => {
    // ReadFailureNote 按传入的查询给重试，重读的就是它
    expect(credentialDetail).toContain(
      '<ReadFailureNote v-if="references.isError.value" :query="references" size="xs" />',
    )
    expect(credentialDetail).toContain('v-else-if="references.data.value" class="section-empty"')
    expect(credentialDetail).toMatch(
      /<ReadFailureNote\s+v-if="events\.isError\.value && !events\.isFetchNextPageError\.value"\s+:query="events"/,
    )
    expect(credentialDetail).toContain('v-if="events.isFetchNextPageError.value"')
  })
})

describe('改版之后的约束', () => {
  it.each([
    ['人格的根', memoryRootPanel],
    ['人格面板', personaPanel],
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
    expect(personaDetail).toContain('此记忆本应进入启动加载')
    expect(personaDetail).toContain('会话开始时此位置将缺失')
    expect(personaPanel).toContain('可用于新人格')
  })

  it('人格：窄屏切换后焦点不掉到 body，标题接得住焦点', () => {
    expect(personaDetail).toMatch(/<h1 ref="titleEl" tabindex="-1">/)
    expect(personaDetail).toContain('defineExpose({ focusTitle')
    expect(personaPanel).toContain('defineExpose({ focusTitle')
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
    expect(credentialsPage).toContain('deletionNotice(retention)')
  })

  it('密码库：断开要确认，确认框写明后果；断开按钮是唯一的砖红', () => {
    expect(vaultConnectionPanel).toContain('<p class="text-sm">{{ disconnectNotice(c) }}</p>')
    expect(vaultConnectionPanel).toContain('@click="confirmingDisconnect = true"')
    expect(vaultConnectionPanel).toContain(
      '<UButton color="error" :loading="busy" @click="disconnect">',
    )
    expect(vaultConnectionPanel.match(/color="error"/g)).toHaveLength(2)
  })

  it('密码库：条目列表只在可用的连接上读，起了标识的跳到凭据', () => {
    expect(vaultConnectionPanel).toContain(
      'enabled: computed(() => props.canManage && itemsAvailable(c.value))',
    )
    expect(vaultConnectionPanel).toContain(
      '@click="emit(\'open-credential\', row.item.credential.id)"',
    )
    expect(vaultConnectionPanel).toContain('@click="emit(\'name-item\', row.item)"')
  })

  it('连接密码库：主密码输入框不让浏览器记住，专用账号的说明放在提示层', () => {
    expect(vaultLoginModal).toMatch(
      /v-model="form\.masterPassword"[^>]*type="password"\s+autocomplete="off"/,
    )
    expect(vaultLoginModal).toContain('仅接受专用账号。<Hint>')
    expect(vaultLoginModal).not.toContain('localStorage')
    expect(vaultLoginModal).not.toContain('useQuery')
  })
})

describe('凭据的弹窗', () => {
  // 连接密码库的提示叫 hint：刚打开的空表单不提示，有失败原因时只显示失败原因
  it.each([
    ['新建凭据', credentialFormModal, 'problem'],
    ['连接密码库', vaultLoginModal, 'hint'],
  ])('%s：底部「为什么不能提交」的提示是 14px 的正文', (name, source, variable) => {
    expect(source, name).toContain(`<span v-if="${variable}" class="mr-auto text-sm text-muted">`)
    expect(source, name).not.toContain(`text-xs text-muted">{{ ${variable} }}`)
  })

  it('连接密码库：什么时候提示由 useVaultLogin 决定，弹窗只负责显示', () => {
    expect(vaultLoginModal).toMatch(/const \{[^}]*\bhint\b[^}]*\} =\s*useVaultLogin\(/)
    expect(vaultLoginModal).not.toContain('const hint')
    expect(vaultLoginModal).not.toContain('edited')
  })
})
