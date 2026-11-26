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

  it('caps oversized content length to preserve semantic signal', () => {
    const text = buildEmbeddingText({
      shortId: 'm-234abc',
      title: '长文档测试',
      summary: '核心结论',
      disclosure: null,
      topics: [],
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      content: '正文'.repeat(3000),
    })
    expect(text.length).toBeLessThan(2_600)
  })
})
