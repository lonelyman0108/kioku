import { describe, expect, it } from 'vitest'

import {
  extractLegacyRefs,
  hasDuplicateLeadingHeading,
  isTitleDirty,
  lintEntryHygiene,
  splitTitleLogSuffix,
  stripDuplicateLeadingHeading,
  stripLegacyGlossaryLines,
} from '../hygiene'

describe('entry hygiene helpers', () => {
  it('strips duplicate leading H1 matching title while keeping code blocks and body intact', () => {
    const body = '# 家庭网络架构总览\n\n## 当前拓扑\n- 主路由正常'
    expect(hasDuplicateLeadingHeading('家庭网络架构总览', body)).toBe(true)
    expect(stripDuplicateLeadingHeading('家庭网络架构总览', body)).toBe('## 当前拓扑\n- 主路由正常')
    expect(stripDuplicateLeadingHeading('其他标题', body)).toBe(body)
    expect(stripDuplicateLeadingHeading('仅标题', '# 仅标题')).toBe('# 仅标题')
  })

  it('strips legacy glossary keyword lines outside code fences', () => {
    const body = [
      '## 配置说明',
      '```text',
      'Glossary keywords: keep_in_fence',
      '```',
      '',
      'Glossary keywords: docker, legacy, test',
    ].join('\n')
    const cleaned = stripLegacyGlossaryLines(body)
    expect(cleaned.removed).toBe(true)
    expect(cleaned.content).toContain('Glossary keywords: keep_in_fence')
    expect(cleaned.content).not.toContain('docker, legacy, test')
  })

  it('extracts legacy URIs and non-shortId wiki links outside code fences', () => {
    const body = [
      '详见 infra://docker_hosts/databases 与 [[wireless_ap]]',
      '参考 projects://kioku/arch，不要写明文密钥；详见 infra://hosts/db。',
      '正常双链 [[m-234abc|已迁移]] 不应报出',
      '```',
      'infra://ignored_in_fence [[ignored_slug]]',
      '```',
    ].join('\n')
    expect(extractLegacyRefs(body)).toEqual({
      uris: ['infra://docker_hosts/databases', 'projects://kioku/arch', 'infra://hosts/db'],
      slugLinks: ['wireless_ap'],
    })
  })

  it('splits log suffix from dirty titles', () => {
    expect(splitTitleLogSuffix('家庭网络架构总览（2026-09-16 更新：重排端口）')).toEqual({
      cleanTitle: '家庭网络架构总览',
      extractedNote: '2026-09-16 更新：重排端口',
    })
    expect(splitTitleLogSuffix('示例工具 @ 本机——已于 2026-10-22 卸载')).toEqual({
      cleanTitle: '示例工具 @ 本机',
      extractedNote: '已于 2026-10-22 卸载',
    })
    expect(splitTitleLogSuffix('家庭网络架构总览（RouterOS）')).toBeNull()
    expect(splitTitleLogSuffix('Redis 集群（迁移方案）')).toBeNull()
    expect(isTitleDirty('家庭网络架构总览（2026-09-16 更新）')).toBe(true)
    expect(isTitleDirty('Redis 集群（迁移方案）')).toBe(false)
    expect(isTitleDirty('家庭网络架构总览')).toBe(false)
  })

  it('emits structured soft warnings for dirty titles, changelogs, missing summary and shrink', () => {
    const dirtyTitle =
      '主机分工与部署偏好（2026-10-21 迁移至新节点；2026-10-30 调整编排与网络结构）'
    const longContent = [
      `# ${dirtyTitle}`,
      '',
      '## 变更记录',
      '- 2026-10-01 初始建立',
      '- 2026-10-15 调整结构',
      '- 2026-10-21 完成迁移，参见 infra://hosts/db',
      '详情'.repeat(800),
      'Glossary keywords: host, docker',
    ].join('\n')

    const warnings = lintEntryHygiene({
      title: dirtyTitle,
      content: longContent,
      isPinned: true,
      summary: null,
      isUpdate: true,
      contentChanged: true,
      changeSummary: null,
      previousContent: `${'旧正文'.repeat(1000)}\n参考 [[m-234abc]]`,
    })
    const codes = warnings.map((w) => w.code)
    expect(codes).toContain('title_too_long')
    expect(codes).toContain('title_has_date_or_log')
    expect(codes).toContain('content_repeats_title')
    expect(codes).toContain('content_has_changelog')
    expect(codes).toContain('content_has_legacy_glossary')
    expect(codes).toContain('legacy_lore_uri')
    expect(codes).toContain('pinned_missing_summary')
    expect(codes).toContain('missing_change_summary')
    expect(codes).toContain('severe_shrink_or_lost_refs')

    // 围栏代码块里的 Glossary keywords 不应误报；丢失凭据占位符应触发告警
    const fencedWarnings = lintEntryHygiene({
      title: '干净标题',
      content: '```text\nGlossary keywords: inside_fence\n```\n纯正文内容',
      isUpdate: true,
      contentChanged: true,
      changeSummary: '更新正文',
      previousContent: '原正文含 {{cred:ops-token}} 凭据',
    })
    expect(fencedWarnings.map((w) => w.code)).not.toContain('content_has_legacy_glossary')
    expect(fencedWarnings.map((w) => w.code)).toContain('severe_shrink_or_lost_refs')

    // 三态常驻与主题数量客观软提醒：全文常驻超 1,200 字报 pinned_oversized；主题超 8 个报 topics_too_many
    const fullOversized = lintEntryHygiene({
      title: 'Codex 运行时约束',
      content: '规则说明。'.repeat(300),
      bootMode: 'full',
      summary: '已有概要',
      envs: [],
      realms: [],
      projects: [],
      runtimes: [],
      topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'],
    })
    expect(fullOversized.map((w) => w.code)).toContain('pinned_oversized')
    expect(fullOversized.map((w) => w.code)).toContain('topics_too_many')

    // 边界：8 个主题不触发提醒，9 个触发 topics_too_many
    const eightTopics = lintEntryHygiene({
      title: '主题边界校验',
      content: '简短正文。',
      summary: '已有概要。',
      topics: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    })
    expect(eightTopics.map((w) => w.code)).not.toContain('topics_too_many')

    // 改为目录常驻并收敛主题至 5 个以内且补齐概要后，提醒全部消失
    const indexScoped = lintEntryHygiene({
      title: 'Codex 运行时约束',
      content: '规则说明。'.repeat(300),
      bootMode: 'index',
      summary: '说明客户端约束边界。',
      runtimes: ['codex'],
      topics: ['codex', 'runtime'],
    })
    expect(indexScoped.map((w) => w.code)).not.toContain('pinned_oversized')
    expect(indexScoped.map((w) => w.code)).not.toContain('topics_too_many')
    expect(indexScoped.map((w) => w.code)).not.toContain('pinned_missing_summary')

    // 目录常驻缺概要报 pinned_missing_summary
    const indexNoSummary = lintEntryHygiene({
      title: '参考手册',
      content: '简短内容',
      bootMode: 'index',
      summary: null,
    })
    expect(indexNoSummary.map((w) => w.code)).toContain('pinned_missing_summary')
  })
})
