import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import appSimulator from '../components/AppSimulator.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import recallDebugPanel from '../components/RecallDebugPanel.vue?raw'
import memoryRow from '../components/strata/MemoryRow.vue?raw'
import recallPage from '../pages/RecallPage.vue?raw'

// 颜色不单独承担信息：一行里有层的色块和 URI 时，色块旁边要写层名。
// 和记忆列表一样用 MemoryFlags，或者同一个 layerShortLabels，不另写一份

interface TemplateNode {
  type: number
  tag?: string
  content?: unknown
  children?: TemplateNode[]
}
const ELEMENT = 1
const INTERPOLATION = 5
const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const nodesOf = (node: TemplateNode): TemplateNode[] => [
  node,
  ...(node.children ?? []).flatMap(nodesOf),
]
const contains = (el: TemplateNode, tag: string) => elementsOf(el).some((e) => e.tag === tag)

// 同时有色块和 URI 的最小那一层元素，就是一行
function swatchRows(source: string): TemplateNode[] {
  const both = (el: TemplateNode) => contains(el, 'StrataSwatch') && contains(el, 'UriPath')
  return elementsOf(template(source)).filter(
    (el) => both(el) && !(el.children ?? []).some((c) => c.type === ELEMENT && both(c)),
  )
}

const namesLayer = (row: TemplateNode) =>
  contains(row, 'MemoryFlags') ||
  nodesOf(row).some(
    (n) =>
      n.type === INTERPOLATION &&
      (n.content as { content: string }).content.includes('layerShortLabels['),
  )

describe('色块旁边的层名', () => {
  it.each([
    ['召回调试的结果', recallDebugPanel, 3],
    ['召回页的常被召回与从未召回', recallPage, 2],
    ['整理建议卡里的记忆', dreamSuggestions, 1],
    ['应用详情的启动加载与相关记忆', appSimulator, 2],
    ['记忆列表的一行', memoryRow, 1],
  ])('%s：每一行都写了层名', (name, source, count) => {
    const rows = swatchRows(source)
    expect(rows.length, name).toBe(count)
    for (const row of rows) expect(namesLayer(row), name).toBe(true)
  })
})
