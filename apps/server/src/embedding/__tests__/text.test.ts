import { serializeEpisodeSignals } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { buildEmbeddingText } from '../text'

describe('buildEmbeddingText', () => {
  it('combines title, summary, disclosure, tags and cleaned body without trailing changelog or duplicate H1', () => {
    const text = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '服务部署规范',
      summary: '所有轻应用部署在统一节点并走编排工具管理。',
      disclosure: '部署新容器服务时查阅',
      topics: ['docker', 'deploy'],
      envs: ['linux'],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      content: [
        '# 服务部署规范',
        '',
        '## 现行原则',
        '- 统一使用 compose 管理。',
        '',
        '## 更新日志',
        '- 2026-09-01 旧工具已退役',
        '- 2026-10-01 迁移记录',
        '',
        '## 关键禁令',
        '- 禁止在数据节点挂载宿主机容器套接字。',
      ].join('\n'),
    })

    expect(text).toContain('服务部署规范')
    expect(text).toContain('所有轻应用部署在统一节点并走编排工具管理。')
    expect(text).toContain('部署新容器服务时查阅')
    expect(text).toContain('统一使用 compose 管理。')
    expect(text).toContain('禁止在数据节点挂载宿主机容器套接字。')
    expect(text).not.toContain('# 服务部署规范')
    expect(text).not.toContain('旧工具已退役')
    // topics 不进入向量文本，避免冗余或脏主题稀释正文语义；场景标签仍保留
    expect(text).not.toContain('docker deploy')
    expect(text).toContain('kioku linux work')
  })

  it('closes H3 changelog skip at sibling H3 heading without swallowing valid H3 sections', () => {
    const text = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '数据库运维',
      summary: null,
      disclosure: null,
      topics: ['postgres'],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: [
        '## 备份方案',
        '### 变更记录',
        '- 2026-09-01 旧脚本下线',
        '### 关键备份规范',
        '- 每日凌晨逻辑备份并校验还原。',
      ].join('\n'),
    })
    expect(text).not.toContain('旧脚本下线')
    expect(text).toContain('每日凌晨逻辑备份并校验还原')
  })

  it('caps oversized content length while appending markdown outline for trailing sections', () => {
    const longWithHeadings = [
      '## 架构总览',
      '基础拓扑说明。'.repeat(420),
      '',
      '## 灾难恢复与冷备步骤',
      '位于 2,500 字之后的冷备流程说明。',
    ].join('\n')
    const text = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '长文档测试',
      summary: '核心结论',
      disclosure: null,
      topics: ['noise-tag-ignored'],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: longWithHeadings,
    })
    expect(text.length).toBeLessThan(3_000)
    expect(text).not.toContain('noise-tag-ignored')
    expect(text).toContain('小节纲要：')
    expect(text).toContain('灾难恢复与冷备步骤')

    // 未超过截断阈值时不追加小节纲要
    const shortWithHeadings = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '短文档测试',
      summary: null,
      disclosure: null,
      topics: [],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: '## 第一节\n简短正文。\n## 第二节\n补充说明。',
    })
    expect(shortWithHeadings).not.toContain('小节纲要：')

    // 超长但无二级小节标题时不追加小节纲要
    const longWithoutHeadings = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '无小节长文',
      summary: null,
      disclosure: null,
      topics: [],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: '纯段落描述。'.repeat(500),
    })
    expect(longWithoutHeadings).not.toContain('小节纲要：')

    // 前段已有大量小节标题时，优先保留 2,500 字之后的尾部小节标题，防止 400 字上限把尾部裁掉
    const manyEarlyHeadings = Array.from(
      { length: 25 },
      (_, idx) => `## 前段配置说明小节编号-${idx + 1}-参数详表\n${'基础说明。'.repeat(22)}`,
    ).join('\n')
    const tailFocused = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '超长多小节手册',
      summary: null,
      disclosure: null,
      topics: [],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: `${manyEarlyHeadings}\n\n## 尾部紧急回滚手册\n回滚细节。`,
    })
    expect(tailFocused).toContain('小节纲要：')
    expect(tailFocused).toContain('尾部紧急回滚手册')
  })

  it('embeds only decoupled structured signals for episodes and returns empty string without signals', () => {
    const signalDisclosure = serializeEpisodeSignals({
      directives: ['按职责拆分 PR 提交', '合并后清理本地工作区与分支'],
      facts: ['本地测试 PostgreSQL 映射端口为 55432'],
    })
    const episodeText = buildEmbeddingText({
      shortId: 'm-ep2345',
      kind: 'episode',
      title: '排查数据库迁移与接口调试',
      summary: null,
      disclosure: signalDisclosure,
      topics: [],
      envs: ['mac'],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      content: '今天排查了半天某项业务逻辑报错和 CSS 样式对齐细节。',
    })
    expect(episodeText).toContain('按职责拆分 PR 提交')
    expect(episodeText).toContain('合并后清理本地工作区与分支')
    expect(episodeText).toContain('本地测试 PostgreSQL 映射端口为 55432')
    // 业务正文、标题与项目标签不得混入 episode 信号向量文本
    expect(episodeText).not.toContain('排查数据库迁移')
    expect(episodeText).not.toContain('CSS 样式对齐')
    expect(episodeText).not.toContain('kioku')

    const noSignalText = buildEmbeddingText({
      shortId: 'm-ep6789',
      kind: 'episode',
      title: '纯叙事会话摘要',
      summary: null,
      disclosure: null,
      topics: [],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: '完成了常规重构任务。',
    })
    expect(noSignalText).toBe('')
  })
})
