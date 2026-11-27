import { describe, expect, it } from 'vitest'

import { entryFieldLabel, eventTypeLabels, formatActorLabel, resolveActorDisplay } from '../labels'
import { analyzeTitleHint, appendExtractedChangeNote } from '../titleHint'

describe('标题非阻断轻提示与拆出', () => {
  it('干净短标题不触发提示', () => {
    const res = analyzeTitleHint('家庭网络架构总览')
    expect(res.dirty).toBe(false)
    expect(res.warnings).toEqual([])
    expect(res.message).toBeNull()
    expect(res.splittable).toBeNull()
  })

  it('检测括号内日期与更新日志并支持拆出短标题', () => {
    const res = analyzeTitleHint('家庭网络架构总览（2026-09-16 更新：重排端口）')
    expect(res.dirty).toBe(true)
    expect(res.message).toBeTruthy()
    expect(res.splittable).toEqual({
      cleanTitle: '家庭网络架构总览',
      extractedNote: '2026-09-16 更新：重排端口',
    })
  })

  it('同时超长且含变更日志时合并提示并保留拆出结果', () => {
    const res = analyzeTitleHint(
      '主机分工与部署偏好清单规范说明总览文档（2026-10-21 迁移至新节点并调整编排）',
    )
    expect(res.dirty).toBe(true)
    expect(res.warnings.map((w) => w.code)).toContain('title_too_long')
    expect(res.warnings.map((w) => w.code)).toContain('title_has_date_or_log')
    expect(res.message).toContain('32 字内')
    expect(res.splittable?.cleanTitle).toBe('主机分工与部署偏好清单规范说明总览文档')
  })

  it('拆出变更说明合并时不重复追加相同片段', () => {
    expect(appendExtractedChangeNote('', '2026-10-21 迁移')).toBe('2026-10-21 迁移')
    expect(appendExtractedChangeNote('调整端口', '2026-10-21 迁移')).toBe(
      '调整端口；2026-10-21 迁移',
    )
    expect(appendExtractedChangeNote('调整端口；2026-10-21 迁移', '2026-10-21 迁移')).toBe(
      '调整端口；2026-10-21 迁移',
    )
    expect(appendExtractedChangeNote('甲'.repeat(280), '乙'.repeat(60)).length).toBeLessThanOrEqual(
      300,
    )
    const createRes = analyzeTitleHint('网络拓扑（2026-10-21 更新）', '', 'create')
    expect(createRes.message).not.toContain('变更说明')
  })
})

describe('操作来源与事件中文映射', () => {
  it('覆盖历史归档事件名与属性字段标签', () => {
    expect(eventTypeLabels.archive_note).toBe('历史归档')
    expect(entryFieldLabel('summary')).toBe('现行概要')
    expect(entryFieldLabel('isPinned')).toBe('常驻')
  })

  it('绝不向界面裸露内部密钥前缀，并正确归类筛选组', () => {
    const keyActor = resolveActorDisplay('key:demo')
    expect(keyActor.label).toBe('访问密钥')
    expect(keyActor.label).not.toContain('key:')
    expect(keyActor.group).toBe('agent')

    const withMeta = resolveActorDisplay('key:demo', {
      kind: 'agent',
      label: 'Claude Code',
      runtimeFamily: 'claudecode',
    })
    expect(withMeta.label).toBe('Claude Code')
    expect(withMeta.group).toBe('agent')

    const dirtyMeta = resolveActorDisplay('key:raw', {
      kind: 'agent',
      label: 'key:leaked_prefix',
      runtimeFamily: 'codex',
    })
    expect(dirtyMeta.label).toBe('Codex')
    expect(dirtyMeta.label).not.toContain('key:')

    expect(formatActorLabel('console')).toBe('本人 · 控制台')
    expect(resolveActorDisplay('console').group).toBe('self')
    expect(formatActorLabel('dream')).toBe('后台整理')
    expect(resolveActorDisplay('dream').group).toBe('dream')
    expect(formatActorLabel('extraction')).toBe('自动摘要')
    expect(formatActorLabel('hygiene:sweep')).toBe('结构检查')
    expect(formatActorLabel('import:lore')).toBe('数据导入（Lore）')
  })
})
