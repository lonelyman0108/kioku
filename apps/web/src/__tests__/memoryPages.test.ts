import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import deletedMemories from '../components/DeletedMemories.vue?raw'
import expiredMemories from '../components/ExpiredMemories.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryHistory from '../components/MemoryHistory.vue?raw'
import memoryListView from '../components/MemoryListView.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'

// 没有组件测试的环境，所以看源码本身：长相改过，这些约束不能跟着丢

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: { name: string }[]
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

describe('记忆详情', () => {
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
