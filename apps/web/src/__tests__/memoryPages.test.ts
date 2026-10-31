import { describe, expect, it } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import createMemoryModal from '../components/CreateMemoryModal.vue?raw'
import deletedMemories from '../components/DeletedMemories.vue?raw'
import expiredMemories from '../components/ExpiredMemories.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryHistory from '../components/MemoryHistory.vue?raw'
import memoryListView from '../components/MemoryListView.vue?raw'
import moveMemoryModal from '../components/MoveMemoryModal.vue?raw'
import OverviewRow from '../components/OverviewRow.vue'
import { DOMAINS_QUERY_OPTIONS } from '../components/memoryTree'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'

// 没有组件测试的环境，所以看源码本身：长相改过，这些约束不能跟着丢

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

// 从根走到第一个这种标签，路上经过了哪些元素
function pathTo(node: TemplateNode, tag: string, path: TemplateNode[] = []): TemplateNode[] | null {
  if (node.type === ELEMENT && node.tag === tag) return path
  for (const child of node.children ?? []) {
    const found = pathTo(child, tag, [...path, node])
    if (found) return found
  }
  return null
}
const conditional = (node: TemplateNode) =>
  node.props?.some((p) => ['if', 'else-if', 'else'].includes(p.name)) ?? false

const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === name)?.value?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const textOf = (el: TemplateNode): string =>
  (el.children ?? [])
    .map((c) => (c as unknown as { content?: unknown }).content)
    .filter((c) => typeof c === 'string')
    .join('')
    .trim()

describe('彩色徽章', () => {
  it('记忆和概览不再用彩色徽章表示敏感级', () => {
    for (const source of [
      overviewPage,
      memoriesPage,
      memoryEditor,
      memoryHistory,
      memoryListView,
      deletedMemories,
      expiredMemories,
    ]) {
      expect(source).not.toContain('sensitivityColors')
      expect(source).not.toContain('<UBadge')
    }
  })
})

describe('记忆页', () => {
  it('列表、已删除、已过期切到目录时不卸载：KeepAlive 不能放在条件分支里', () => {
    const path = pathTo(template(memoriesPage), 'KeepAlive')
    expect(path).not.toBeNull()
    expect(path!.some(conditional)).toBe(false)
  })

  it('换记忆时编辑器重建，查看过的机密正文跟着丢', () => {
    expect(memoriesPage).toContain(':key="`${spaceId}|${selectedUri}`"')
  })

  it('目录没有文件夹图标，按层筛选落在列表上', () => {
    expect(memoriesPage).not.toContain('icons.folder')
    expect(memoriesPage).toMatch(/view: 'list',\s+layer: same \? null : layer/)
  })
})

describe('目录的键盘和无障碍', () => {
  const tree = elementsOf(template(memoriesPage)).find((el) => el.tag === 'UTree')!

  it('目录有名字', () => {
    expect(attr(tree, 'aria-label')).toBe('记忆目录')
  })

  it('左键抢在组件库之前处理：它只在渲染出来的行里找上一级', () => {
    const capture = tree.props?.find(
      (p) =>
        p.name === 'on' && p.arg?.content === 'keydown' && JSON.stringify(p).includes('capture'),
    )
    expect(capture?.exp?.content).toBe('onTreeLeftKey')
    expect(memoriesPage).toMatch(/parentRow\(places\.value, expanded\.value, uri\)/)
  })

  it('打字跳转留给页面，组件库的那份给空文字关掉', () => {
    expect(handler(tree, 'keydown')).toBeDefined()
    expect(memoriesPage).toContain("textContent: () => ''")
  })

  it('带修饰键的按键放行：Alt+← 是后退', () => {
    const body = (name: string) =>
      new RegExp(`function ${name}\\(event: KeyboardEvent\\) \\{\\n(.*)\\n`).exec(memoriesPage)![1]!
    expect(body('onTreeLeftKey')).toContain('hasModifier(event)')
    expect(body('onTreeKeydown')).toContain('hasModifier(event)')
    expect(memoriesPage).toContain('event.altKey || event.metaKey || event.ctrlKey')
  })

  it('新的跳转让还在等的作废，旧的不抢焦点', () => {
    expect(memoriesPage).toContain('cancelAnimationFrame(focusWait)')
    expect(memoriesPage).toContain('focusWait = requestAnimationFrame')
  })

  it('这一栏重新显示时告诉虚拟滚动，转屏后不空白', () => {
    expect(memoriesPage).toContain('!narrow.value || !selectedUri.value')
    expect(memoriesPage).toMatch(/watch\(indexVisible,[\s\S]*?scrollToRow\(selectedUri\.value\)/)
    expect(memoriesPage).toContain("el.dispatchEvent(new Event('scroll'))")
  })

  it('刚删掉的 URI 用完就清：重建之后返回还回到那一行', () => {
    expect(memoriesPage).toMatch(
      /async function onDeleted[\s\S]*?deletedUri = uri[\s\S]*?deletedUri = null\n\}/,
    )
  })

  it('窄屏切换后焦点不掉到 body：标题能接住焦点，返回时放回那一行', () => {
    const title = elementsOf(template(memoryEditor)).find((el) => el.tag === 'h1')!
    expect(attr(title, 'tabindex')).toBe('-1')
    expect(memoryEditor).toContain('defineExpose({ focusTitle')
    expect(memoriesPage).toContain('focusAfterSelect(narrow.value, uri, previous)')
    expect(memoriesPage).toContain('focusIndexRow(target.uri)')
  })

  it('触屏上箭头的热区放大，行高和样式跟着粗指针走', () => {
    expect(memoriesPage).toContain('@media (pointer: coarse)')
    expect(memoriesPage).toContain("matchMedia('(pointer: coarse)')")
  })

  it('热区只往左伸，不盖到色块和名字：点名字要是打开', () => {
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(memoriesPage)![1]!
    const before = /\.chevron::before \{([\s\S]*?)\}/.exec(coarse)![1]!
    expect(before).toMatch(/inset: 0 0 0 -\d+px/)
    // 这一列加宽和往左伸出去的合起来不小于 32px
    const width = Number(/\.chevron \{[\s\S]*?width: (\d+)px/.exec(coarse)![1])
    const left = Number(/inset: 0 0 0 -(\d+)px/.exec(before)![1])
    expect(width + left).toBeGreaterThanOrEqual(32)
    // 往左不能超过行首的内边距，不然第一层的热区被这一栏裁掉
    expect(left).toBeLessThanOrEqual(5)
  })
})

describe('记忆页取统计', () => {
  it('窄柱的统计不跟着每次写入重取：只标记过期，统计变了才取一次', () => {
    expect(memoriesPage).toContain('staleTime: 60_000')
    expect(memoriesPage).toContain("refetchType: 'none'")
    expect(memoriesPage).toContain('statsChanged(before, memory)')
  })

  it('invalidateLists 不再让概览跟着失效重取', () => {
    const body = /function invalidateLists\(\) \{[\s\S]*?\n\}/.exec(memoriesPage)![0]
    const list = /for \(const key of \[([\s\S]*?)\]\)/.exec(body)![1]!
    expect(list).not.toContain('overview')
    expect(body).not.toContain('overview.refetch')
  })

  it('读 domain 列表不等重试，离线也不卡住目录的队列：每个用到这个查询的地方都带同样的选项', () => {
    expect(DOMAINS_QUERY_OPTIONS).toEqual({ retry: false, networkMode: 'always' })
    expect(memoriesPage.match(/\.\.\.DOMAINS_QUERY_OPTIONS/g)).toHaveLength(2)
    expect(memoryListView).toContain('...DOMAINS_QUERY_OPTIONS')
  })
})

// 回车的隐式提交会点默认按钮：单选在表单里时，方向键选完再按回车，提示还没看就提交了
describe.each([
  ['移动或改层', moveMemoryModal, '确定'],
  ['新建记忆', createMemoryModal, '创建'],
])('%s的弹窗', (_name, source, label) => {
  const elements = elementsOf(template(source))

  it('没有表单，也没有提交按钮', () => {
    expect(elements.filter((el) => el.tag === 'form')).toEqual([])
    expect(elements.filter((el) => attr(el, 'type') === 'submit')).toEqual([])
    expect(source).not.toContain('@submit')
  })

  it('只有点按钮才提交', () => {
    const button = elements.find((el) => el.tag === 'UButton' && textOf(el) === label)!
    expect(handler(button, 'click')).toBe('submit')
  })
})

describe('概览的一行', () => {
  // 没有路由，RouterLink 换成一个普通的 a，属性照样落上去
  const render = (props: Record<string, unknown>) => {
    const app = createSSRApp(OverviewRow, props)
    app.component(
      'RouterLink',
      defineComponent({
        setup:
          (_, { slots }) =>
          () =>
            h('a', slots.default?.()),
      }),
    )
    return renderToString(app)
  }

  it('操作都叫「查看」时，读屏能分清是哪一行', async () => {
    const link = await render({ title: '整理建议', value: 2, action: '查看', to: '/review' })
    expect(link).toContain('aria-label="整理建议：查看"')
    const button = await render({
      title: '账号绑定申请',
      value: 1,
      action: '查看',
      expanded: false,
    })
    expect(button).toContain('aria-label="账号绑定申请：查看"')
    expect(button).toContain('aria-expanded="false"')
  })

  it('没有要做的事时没有操作', async () => {
    const html = await render({ title: '整理建议', value: 0, action: null, zero: true })
    expect(html).not.toContain('row-action')
  })
})

describe('记忆详情', () => {
  it('启动加载的提示写清只是够格，不再说一定加载', () => {
    expect(memoryEditor).toContain('<Hint>{{ BOOT_HINT }}</Hint>')
    expect(memoryEditor).toContain(':title="BOOT_HINT"')
    expect(memoryEditor).not.toContain('每次会话开始时加载')
  })

  it('补全的说明跟着情况换，不一律说召回', () => {
    expect(memoryEditor).toContain('{{ missingDisclosureHint(base, now) }}')
    expect(memoryEditor).not.toContain('<Hint>补全后召回更准确。</Hint>')
  })

  it('没写触发场景的提示按 missingDisclosureTone 走，列表和详情一个规则', () => {
    expect(memoryEditor).toContain('missingDisclosureTone(base.value, now.value)')
    expect(memoryEditor).toMatch(/<NoteLine\s+v-if="disclosureTone"/)
    expect(memoryListView).toContain('v-if="missingDisclosureTone(item)"')
    expect(memoryListView).not.toContain('启动加载')
  })

  it('编辑和历史都就地切换，不弹窗', () => {
    expect(memoryEditor).not.toContain('USlideover')
    expect(memoryEditor).toContain('v-else-if="historyOpen"')
  })

  it('保存带着载入时的 id 和版本，冲突时重新读取', () => {
    expect(memoryEditor).toContain('expectedId: m.id')
    expect(memoryEditor).toContain('expectedVersion: m.version')
    expect(memoryEditor).toMatch(/err\.status === 409\) void memory\.refetch\(\)/)
  })

  it('离开前确认，换视图和筛选不算离开', () => {
    expect(memoryEditor).toContain('useUnsavedChangesGuard(dirty')
    expect(memoryEditor).toMatch(/to\.query\.uri !== from\.query\.uri/)
  })

  it('机密的正文只放在组件里，不写进查询缓存', () => {
    const reveal = /async function revealContent\(\) \{[\s\S]*?\n\}/.exec(memoryEditor)![0]
    expect(reveal).toContain('revealed.value =')
    expect(reveal).not.toContain('setQueryData')
  })

  it('明文提醒和降级确认的后果还在', () => {
    expect(memoryEditor).toContain('降级后，正文将写入历史、全文索引和向量，无法撤回')
    expect(memoryEditor).toContain('确认不含明文并降级')
    expect(memoryEditor).toContain('allowPlaintext: true')
  })
})

describe('概览', () => {
  it('账号绑定在这里能处理：行内展开，确认的说明还在', () => {
    expect(overviewPage).toContain('<SubjectBindings')
    expect(overviewPage).toContain(
      '确认后，该账号的私聊视为本人对话，此操作不可撤销。如无法辨认，请拒绝。',
    )
  })

  it('待处理的数量来自接口的 inbox', () => {
    expect(overviewPage).toContain('data.inbox.total')
    expect(overviewPage).toContain('data.inbox.bindings')
  })

  it('来自对话的两层不在记忆列表里，带去联系人页', () => {
    expect(overviewPage).toMatch(
      /isConversationLayer\(selection\.layer\)\) \{\s+void router\.push\(\{ name: 'subjects'/,
    )
  })
})
