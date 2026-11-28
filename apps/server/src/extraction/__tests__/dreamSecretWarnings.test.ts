import { DreamSuggestionView, type DreamSecretWarning } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import type { CredentialService } from '../../credential/service'
import type { Db } from '../../db/client'
import { dreamSuggestions, entries } from '../../db/schema'
import { EntryService } from '../../memory/service'
import { hydrateDreamSuggestions } from '../dream'
import {
  buildDreamMessages,
  buildTidyMessages,
  evaluateDreamResponse,
  evaluateTidyResponse,
  parseSecretWarnings,
  type DreamPromptItem,
} from '../dreamPrompt'

function makePromptItem(overrides: Partial<DreamPromptItem> = {}): DreamPromptItem {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    shortId: 'm-234abc',
    kind: 'entry',
    title: '部署说明',
    summary: '服务部署步骤。',
    content: '## 数据库\n使用服务账号连接生产库。',
    disclosure: null,
    bootMode: 'none',
    envs: ['linux'],
    realms: ['work'],
    projects: ['kioku'],
    runtimes: [],
    topics: ['deploy'],
    version: 1,
    verifiedAt: null,
    updatedAt: '2026-11-28T00:00:00.000Z',
    truncated: false,
    ...overrides,
  }
}

describe('LLM 整理 secret_warnings 提示词、脱敏清洗与建议透传', () => {
  it('standard 与 tidy 的系统提示词均包含禁止回显完整明文的 secret_warnings 指令', () => {
    const item = makePromptItem()
    const stdMsgs = buildDreamMessages([item], [])
    const tidyMsgs = buildTidyMessages(item, ['deploy'])

    expect(stdMsgs[0]?.content).toContain('secret_warnings')
    expect(stdMsgs[0]?.content).toContain('严禁原样输出完整明文')
    expect(tidyMsgs[0]?.content).toContain('secret_warnings')
    expect(tidyMsgs[0]?.content).toContain('严禁在 secret_warnings 中原样输出完整明文')
  })

  it('parseSecretWarnings 保留已打码短提示，并强制脱敏违规回显的完整密钥、连接串与长密码', () => {
    const rawKey = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-')
    const rawDb = 'postgres://svc:SuperSecret999@db.prod.internal:5432/prod'
    const rawPwd = 'MyP@ssw0rd!2026Secret'
    const rawGithub = 'ghp_1234567890abcdef12345678'

    const parsed = parseSecretWarnings([
      {
        label: 'OpenAI 密钥',
        location: '## 环境配置',
        masked_snippet: rawKey,
      },
      {
        label: `数据库连接 ${rawDb}`,
        location: `## 部署 ${rawGithub}`,
        masked_snippet: rawDb,
      },
      {
        label: '管理员密码',
        location: '## 登录信息',
        masked_snippet: rawPwd,
      },
      {
        label: '环境变量密码',
        location: '## 脚本',
        masked_snippet: 'DB_PASS=VeryLongPassword999',
      },
      {
        label: '半打码令牌',
        location: '## 接口',
        masked_snippet: 'ghp_1234567890***',
      },
      {
        label: '已打码提示',
        location: '## 备注',
        masked_snippet: 'sk-p***',
      },
      // 重复项与无效项应去重或丢弃
      {
        label: '已打码提示',
        location: '## 备注',
        masked_snippet: 'sk-p***',
      },
      { label: '   ' },
      'invalid-entry',
    ])

    expect(parsed).toHaveLength(6)
    const serialized = JSON.stringify(parsed)
    expect(serialized).not.toContain(rawKey)
    expect(serialized).not.toContain('SuperSecret999')
    expect(serialized).not.toContain(rawPwd)
    expect(serialized).not.toContain('VeryLongPassword999')
    expect(serialized).not.toContain(rawGithub)
    expect(serialized).not.toContain('ghp_1234567890')

    expect(parsed[0]).toEqual({
      label: 'OpenAI 密钥',
      location: '## 环境配置',
      maskedSnippet: 'sk-***',
    })
    expect(parsed[1]?.maskedSnippet).toBe('pos***')
    expect(parsed[2]?.maskedSnippet).toBe('MyP***')
    expect(parsed[3]?.maskedSnippet).toBe('DB_PASS=Ver***')
    expect(parsed[4]?.maskedSnippet).toBe('ghp***')
    expect(parsed[5]).toEqual({
      label: '已打码提示',
      location: '## 备注',
      maskedSnippet: 'sk-p***',
    })

    // 长度与条数上限强制截断
    const overflow = parseSecretWarnings(
      Array.from({ length: 12 }, (_, idx) => ({
        label: `告警类型${idx}_${'长'.repeat(80)}`,
        location: `小节${idx}_${'位'.repeat(100)}`,
        masked_snippet: `ab***${'x'.repeat(60)}`,
      })),
    )
    expect(overflow).toHaveLength(8)
    for (const w of overflow) {
      expect(w.label.length).toBeLessThanOrEqual(64)
      expect((w.location ?? '').length).toBeLessThanOrEqual(80)
      expect((w.maskedSnippet ?? '').length).toBeLessThanOrEqual(48)
    }

    // 对抗测试：裸 JWT/随机 Hex/含特殊字符强密码/密码含 @ 的连接串/无 END 行私钥块均不得在任意字段逃逸
    const bareJwt = [
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      'eyJzdWIiOiJhZG1pbi0xMjM0NTYifQ',
      'K9xM2pQ7wV4nB8zL1tR6yF3cH5dJ0sA',
    ].join('.')
    const randomHex = 'deadbeef0123456789abcdef98765432'
    const starPwd = 'P@ss*w0rd:99.x"y'
    const atUri = 'postgres://svc:p@ss@word99@db.prod.internal:5432/prod'
    const unclosedPem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdef',
      'ZXhhbXBsZWtleWJ5dGVzMTIzNDU2Nzg5',
    ].join('\n')

    const adversarial = parseSecretWarnings([
      {
        label: `认证令牌 ${bareJwt}`,
        location: `## 鉴权 ${randomHex}`,
        masked_snippet: starPwd,
      },
      {
        label: `密码泄露 ${starPwd}`,
        location: `## 配置 ${atUri}`,
        masked_snippet: atUri,
      },
      {
        label: `私钥 ${unclosedPem}`,
        location: `## 密钥 ${bareJwt}`,
        masked_snippet: unclosedPem,
      },
      {
        label: '赋值泄露',
        location: '## 环境变量 API_SECRET=UltraSecretVal999',
        masked_snippet: 'p*ssw0rdSecret99',
      },
    ])

    const advText = JSON.stringify(adversarial)
    expect(advText).not.toContain(bareJwt)
    expect(advText).not.toContain('eyJzdWIi')
    expect(advText).not.toContain(randomHex)
    expect(advText).not.toContain('w0rd:99')
    expect(advText).not.toContain('word99')
    expect(advText).not.toContain('MIIEpAIBAAKCAQEA')
    expect(advText).not.toContain('ZXhhbXBsZWtleWJ5dGVz')
    expect(advText).not.toContain('UltraSecretVal999')
    expect(advText).not.toContain('ssw0rdSecret99')
    expect(adversarial[0]?.maskedSnippet).toBe('P***')
    expect(adversarial[1]?.maskedSnippet).toBe('pos***')
    expect(adversarial[2]?.maskedSnippet).toBe('私钥***')
    expect(adversarial[3]?.maskedSnippet).toBe('p***')

    // 中文与全角标点无空格紧邻密码/赋值时也必须截断脱敏，且不误伤正常中文括号标签
    const cjkAdjacent = parseSecretWarnings([
      {
        label: '管理员密码：MyP@ssw0rd!2026',
        location: '## 配置（DB_PASS=MyP@ss!99）',
        masked_snippet: 'MyP***',
      },
      {
        label: '密码：Passw0rd2026Abc',
        location: '登录密码：P@ss*w0rd:99',
        masked_snippet: '私钥***',
      },
      {
        label: 'OpenAI 密钥',
        location: '## 登录（OAuth2）',
        masked_snippet: 'sk-p***',
      },
      {
        label: '数据库主密码',
        location: '## 数据库（prod-pg）',
        masked_snippet: '私钥***',
      },
    ])

    const cjkText = JSON.stringify(cjkAdjacent)
    expect(cjkText).not.toContain('MyP@ssw0rd!2026')
    expect(cjkText).not.toContain('MyP@ss!99')
    expect(cjkText).not.toContain('Passw0rd2026Abc')
    expect(cjkText).not.toContain('P@ss*w0rd:99')

    expect(cjkAdjacent[0]).toEqual({
      label: '管理员密码：MyP***',
      location: '## 配置（DB_PASS=MyP***）',
      maskedSnippet: 'MyP***',
    })
    expect(cjkAdjacent[1]).toEqual({
      label: '密码：Pas***',
      location: '登录密码：P***',
      maskedSnippet: '私钥***',
    })
    expect(cjkAdjacent[2]).toEqual({
      label: 'OpenAI 密钥',
      location: '## 登录（OAuth2）',
      maskedSnippet: 'sk-p***',
    })
    expect(cjkAdjacent[3]).toEqual({
      label: '数据库主密码',
      location: '## 数据库（prod-pg）',
      maskedSnippet: '私钥***',
    })
  })

  it('evaluateDreamResponse、evaluateTidyResponse 与 hydrateDreamSuggestions 安全透传 secretWarnings', async () => {
    const item = makePromptItem({
      content: '旧版配置说明，含疑似密钥。',
    })
    const catalog = new Map([[item.shortId, item]])

    const stdRes = evaluateDreamResponse(
      JSON.stringify({
        suggestions: [
          {
            kind: 'update',
            target_short_ids: [item.shortId],
            content: '新版配置说明，待迁移凭据占位符。',
            reason: '补充现行说明并提示清理疑似明文',
            secret_warnings: [
              {
                label: '服务令牌',
                location: '## 认证',
                masked_snippet: 'ghp_123456789012345678901234',
              },
            ],
          },
        ],
      }),
      catalog,
    )
    expect(stdRes.status).toBe('ok')
    if (stdRes.status === 'ok') {
      expect(stdRes.proposals[0]?.secretWarnings).toEqual([
        { label: '服务令牌', location: '## 认证', maskedSnippet: 'ghp***' },
      ])
    }

    const tidyRes = evaluateTidyResponse(
      JSON.stringify({
        needed: true,
        title: '部署配置规范',
        summary: '整理部署配置并提示清理明文凭据。',
        content: '## 现行配置\n已整理为结构化说明。',
        change_summary: '规范标题与正文',
        archived_notes: [],
        reason: '标题与正文需要规范化',
        secret_warnings: [
          {
            label: '数据库密码',
            location: '## 连接参数',
            masked_snippet: 'db-***',
          },
        ],
      }),
      item,
    )
    expect(tidyRes.status).toBe('proposal')
    if (tidyRes.status === 'proposal') {
      expect(tidyRes.proposal.secretWarnings).toEqual([
        { label: '数据库密码', location: '## 连接参数', maskedSnippet: 'db-***' },
      ])
    }

    // 校验 hydrateDreamSuggestions 透传到 DreamSuggestionView（/console/inbox 契约）
    const now = new Date('2026-11-28T00:00:00.000Z')
    const fakeEntry: typeof entries.$inferSelect = {
      id: item.id,
      shortId: item.shortId,
      kind: 'entry',
      title: item.title,
      summary: item.summary ?? null,
      content: item.content,
      disclosure: null,
      isPinned: false,
      bootMode: 'none',
      envs: item.envs,
      realms: item.realms,
      projects: item.projects,
      runtimes: item.runtimes,
      topics: item.topics,
      deviceKey: null,
      projectSlug: null,
      searchTags: '',
      validTo: null,
      verifiedAt: null,
      lastChangeSummary: null,
      version: 1,
      dreamCheckedVersion: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      fts: null,
    }
    const fakeDb = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => Promise.resolve(table === entries ? [fakeEntry] : []),
        }),
      }),
    } as unknown as Db

    const views = await hydrateDreamSuggestions(fakeDb, [
      {
        id: '20000000-0000-4000-8000-000000000001',
        kind: 'tidy',
        entryIds: [item.id],
        entryVersions: [1],
        keepId: null,
        proposedTitle: '部署配置规范',
        proposedSummary: '整理部署配置。',
        proposedContent: '## 现行配置\n已整理。',
        proposedDisclosure: null,
        proposedChangeSummary: '规范标题与正文',
        archivedNotes: null,
        proposedTopics: null,
        proposedEnvs: null,
        proposedRealms: null,
        proposedProjects: null,
        proposedRuntimes: null,
        proposedLinks: null,
        proposedBootMode: null,
        secretWarnings: [{ label: '数据库密码', location: '## 连接参数', maskedSnippet: 'db-***' }],
        reason: '规范化',
        fingerprint: 'fp-1',
        status: 'pending',
        createdAt: now,
        decidedAt: null,
      },
    ])

    const validated = DreamSuggestionView.parse(views[0])
    expect(validated.secretWarnings).toEqual([
      { label: '数据库密码', location: '## 连接参数', maskedSnippet: 'db-***' },
    ])
  })

  it('EntryService.applySingleTidy 暂存至整理前对外部传入的 secretWarnings 执行二次清洗', async () => {
    const now = new Date('2026-11-28T00:00:00.000Z')
    const entryRow: typeof entries.$inferSelect = {
      id: '10000000-0000-4000-8000-000000000099',
      shortId: 'm-234stg',
      kind: 'entry',
      title: '部署说明',
      summary: '部署概要',
      content: '正文内容',
      disclosure: null,
      isPinned: false,
      bootMode: 'none',
      envs: [],
      realms: ['work'],
      projects: ['kioku'],
      runtimes: [],
      topics: ['deploy'],
      deviceKey: null,
      projectSlug: null,
      searchTags: '',
      validTo: null,
      verifiedAt: null,
      lastChangeSummary: null,
      version: 1,
      dreamCheckedVersion: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      fts: null,
    }

    let capturedInsertWarnings: DreamSecretWarning[] | null = null
    let capturedConflictWarnings: DreamSecretWarning[] | null = null

    const tx = {
      execute: async () => [{ micros: String(BigInt(now.getTime()) * 1000n) }],
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const limit = async () => (table === entries ? [entryRow] : [])
            return { limit, orderBy: () => ({ limit }) }
          },
        }),
      }),
      insert: (table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          if (table === dreamSuggestions) {
            capturedInsertWarnings = (vals.secretWarnings as DreamSecretWarning[] | null) ?? null
          }
          return {
            onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
              if (table === dreamSuggestions) {
                capturedConflictWarnings =
                  (opts.set.secretWarnings as DreamSecretWarning[] | null) ?? null
              }
              return {
                returning: async () => [{ id: '20000000-0000-4000-8000-000000000099' }],
              }
            },
          }
        },
      }),
    }
    const fakeDb = {
      transaction: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
    } as unknown as Db

    const svc = new EntryService(fakeDb, null, {} as CredentialService, null)
    const rawApiSecret = ['sk', 'proj', '9876543210abcdefghijkl'].join('-')
    await svc.applySingleTidy(
      { kind: 'console', accountId: 'acc', sessionId: 'sess' },
      'm-234stg',
      {
        expectedVersion: 1,
        title: '部署说明',
        summary: '部署概要',
        content: '正文内容（已规范）',
        stageToInbox: true,
        secretWarnings: [
          {
            label: `密钥 ${rawApiSecret}`,
            location: '## 认证 P@ss*w0rd:99',
            maskedSnippet: 'postgres://svc:p@ss@word@db.prod.internal:5432/prod',
          },
        ],
      },
    )

    const serialized = JSON.stringify({ capturedInsertWarnings, capturedConflictWarnings })
    expect(serialized).not.toContain(rawApiSecret)
    expect(serialized).not.toContain('P@ss*w0rd:99')
    expect(serialized).not.toContain('p@ss@word')
    expect(capturedInsertWarnings).toEqual([
      {
        label: '密钥 sk-***',
        location: '## 认证 P***',
        maskedSnippet: 'pos***',
      },
    ])
    expect(capturedConflictWarnings).toEqual(capturedInsertWarnings)
  })
})
