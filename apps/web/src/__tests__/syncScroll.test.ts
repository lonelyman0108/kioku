import { describe, expect, it } from 'vitest'

import {
  buildMonotonicAnchors,
  extractMarkdownBlockOffsets,
  interpolateScroll,
} from '../composables/useMarkdownSyncScroll'

describe('分栏编辑锚点同步滚动算法', () => {
  it('剔除重复首行一级标题时记录精确偏移，并细化长列表内的逐项锚点', () => {
    const doc = [
      '# 家庭网络架构总览',
      '',
      '## 核心拓扑',
      '- 节点一：主路由',
      '- 节点二：万兆交换',
      '- 节点三：书房 AP',
      '',
      '## 排障说明',
      '修改 trunk 前先开启 Safe Mode。',
    ].join('\n')

    const { previewStartOffset, blocks } = extractMarkdownBlockOffsets(doc, '家庭网络架构总览')
    expect(previewStartOffset).toBe('# 家庭网络架构总览\n\n'.length)
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'heading', 'paragraph'])
    expect(blocks[0]!.charOffset).toBe(doc.indexOf('## 核心拓扑'))
    expect(blocks[1]!.listItemOffsets).toEqual([
      doc.indexOf('- 节点一'),
      doc.indexOf('- 节点二'),
      doc.indexOf('- 节点三'),
    ])
    expect(blocks[2]!.charOffset).toBe(doc.indexOf('## 排障说明'))
  })

  it('构建严格单调不减的锚点表并支持双向分段线性插值', () => {
    const anchors = buildMonotonicAnchors(
      [
        { src: 120, pre: 80 },
        { src: 400, pre: 260 },
        // 非单调噪声点应被安全滤除
        { src: 350, pre: 300 },
        { src: 800, pre: 600 },
      ],
      1000,
      700,
    )
    expect(anchors[0]).toEqual({ src: 0, pre: 0 })
    expect(anchors.at(-1)).toEqual({ src: 1000, pre: 700 })
    for (let i = 1; i < anchors.length; i++) {
      expect(anchors[i]!.src).toBeGreaterThanOrEqual(anchors[i - 1]!.src)
      expect(anchors[i]!.pre).toBeGreaterThanOrEqual(anchors[i - 1]!.pre)
    }

    // 正向：源码 -> 预览
    expect(interpolateScroll(anchors, 0, 'src')).toBe(0)
    expect(interpolateScroll(anchors, 120, 'src')).toBe(80)
    expect(interpolateScroll(anchors, 260, 'src')).toBeCloseTo(170, 5)
    expect(interpolateScroll(anchors, 1000, 'src')).toBe(700)

    // 反向：预览 -> 源码
    expect(interpolateScroll(anchors, 80, 'pre')).toBe(120)
    expect(interpolateScroll(anchors, 170, 'pre')).toBeCloseTo(260, 5)
    expect(interpolateScroll(anchors, 700, 'pre')).toBe(1000)
  })
})
