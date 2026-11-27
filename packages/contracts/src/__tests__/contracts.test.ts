import { describe, expect, it } from 'vitest'

import {
  API_GENERATION,
  ApplySuggestionResponse,
  BootResponse,
  CapturePlanRequest,
  CapturePlanResponse,
  CreateApiKeyRequest,
  DeviceAuthorizeRequest,
  DeviceGrantApproveRequest,
  DeviceGrantApproveResponse,
  DeviceTokenResponse,
  DREAM_KINDS,
  DreamEntrySnapshot,
  HealthResponse,
  LifecycleEventRequest,
  RecallRequest,
  RebuildEmbeddingsResponse,
  REVISABLE_DREAM_KINDS,
  ReviseSuggestionRequest,
  ReviseSuggestionResponse,
  ResolveCredentialsRequest,
  RotateApiKeyRequest,
  SetupRequest,
  UnavailableHealthResponse,
  UpdateModelsSettingsRequest,
  versionLabel,
  WhoAmIResponse,
} from '../index'

describe('wire-compatible contracts', () => {
  it('accepts single and multi-platform device authorize and maps other to generic', () => {
    expect(
      DeviceAuthorizeRequest.parse({ runtimeFamily: 'claudecode', clientName: 'MBP' }),
    ).toEqual({ runtimeFamily: 'claudecode', clientName: 'MBP' })
    expect(DeviceAuthorizeRequest.parse({ runtimeFamily: 'other' })).toEqual({
      runtimeFamily: 'generic',
    })
    expect(
      DeviceAuthorizeRequest.parse({
        platforms: [{ runtimeFamily: 'claudecode' }, { runtimeFamily: 'codex', clientName: 'CLI' }],
      }).platforms,
    ).toHaveLength(2)
    expect(DeviceAuthorizeRequest.safeParse({}).success).toBe(false)
    expect(
      DeviceAuthorizeRequest.safeParse({
        runtimeFamily: 'claudecode',
        platforms: [{ runtimeFamily: 'codex' }],
      }).success,
    ).toBe(false)

    expect(
      DeviceTokenResponse.parse({
        status: 'approved',
        key: 'kioku_live_abc',
        client: { slug: 'claudecode', name: 'MBP', runtimeFamily: 'claudecode' },
      }),
    ).toMatchObject({ status: 'approved' })

    expect(
      DeviceGrantApproveRequest.parse({
        userCode: 'bcdf-ghjk',
        envs: ['mac'],
        allowedRealms: ['work'],
        canResolveCredentials: true,
        items: [{ runtimeFamily: 'claudecode', keyName: 'Work Mac' }],
      }),
    ).toMatchObject({ userCode: 'BCDFGHJK', envs: ['mac'], allowedRealms: ['work'] })
    expect(
      DeviceGrantApproveResponse.parse({
        items: [{ runtimeFamily: 'claudecode', keyName: 'Work Mac' }],
      }).items,
    ).toHaveLength(1)
  })

  it('keeps lifecycle and recall requests wire-compatible with optional nullish context', () => {
    const start = LifecycleEventRequest.parse({
      event: 'session.start',
      deviceKey: 'mac-mini',
      project: { repoName: 'kioku' },
      context: { chatType: 'direct', platform: 'legacy', sender: { id: '1' } },
    })
    expect(start.event).toBe('session.start')

    const nullCtx = LifecycleEventRequest.parse({
      event: 'prompt.submit',
      prompt: '部署配置',
      context: null,
    })
    expect(nullCtx.context).toBeNull()

    const recallSlug = RecallRequest.parse({ query: 'docker', project: 'kioku', context: null })
    expect(recallSlug.project).toBe('kioku')
    const recallObj = RecallRequest.parse({
      query: 'docker',
      project: { repoName: 'kioku', dirName: 'kioku' },
    })
    expect(recallObj.project).toEqual({ repoName: 'kioku', dirName: 'kioku' })

    const turn = LifecycleEventRequest.parse({
      event: 'turn.end',
      sessionId: 'sess-1',
      user: '怎么启动数据库？',
      reply: '运行 docker compose up -d',
      context: { chatType: 'subagent' },
    })
    expect(turn.context?.chatType).toBe('subagent')
  })

  it('supports both bare slug and slug#field on credential resolve', () => {
    const req = ResolveCredentialsRequest.parse({
      refs: [{ identifier: 'pg-main' }, { identifier: 'github-pat', field: 'token' }],
      purpose: 'connect db',
    })
    expect(req.refs).toHaveLength(2)
    expect(
      ResolveCredentialsRequest.safeParse({
        refs: [{ identifier: 'pg-main' }, { identifier: 'pg-main' }],
      }).success,
    ).toBe(false)
  })

  it('keeps smoke-image SetupRequest spaceName compatible and exposes clean settings/dream/auth schemas', () => {
    expect(
      SetupRequest.parse({
        setupCode: 'SMOKE-SETUP-CODE-0001',
        username: 'smoke',
        displayName: 'Smoke',
        password: 'correct horse battery',
        spaceName: 'smoke',
      }).username,
    ).toBe('smoke')

    expect(DREAM_KINDS).toEqual([
      'distill_episode',
      'merge_duplicates',
      'mark_stale',
      'update',
      'tidy',
      'link_entries',
      'adjust_boot_mode',
    ])

    expect(
      CreateApiKeyRequest.parse({
        name: 'Work Mac',
        runtimeFamily: 'claudecode',
        envs: ['mac'],
        allowedRealms: ['work'],
      }),
    ).toMatchObject({ canWrite: true, canResolveCredentials: false })

    expect(
      WhoAmIResponse.parse({
        accountName: 'Owner',
        key: {
          id: '00000000-0000-4000-8000-000000000001',
          name: 'Work Mac',
          prefix: 'kk_abc',
          runtimeFamily: 'claudecode',
          envs: ['mac'],
          allowedRealms: null,
          canWrite: true,
          canResolveCredentials: true,
        },
        client: { slug: 'claudecode', name: 'Work Mac', runtimeFamily: 'claudecode' },
        primaryCircle: { slug: 'default', name: 'Kioku', kind: 'personal' },
      }).primaryCircle?.slug,
    ).toBe('default')

    expect(
      UpdateModelsSettingsRequest.parse({
        embedding: { baseUrl: 'https://api.example.com/v1/', model: 'text-embedding-3-small' },
        dream: { enabled: true, intervalHours: 24 },
      }).embedding?.baseUrl,
    ).toBe('https://api.example.com/v1')

    expect(versionLabel('1.2.3')).toBe('v1.2.3')
    expect(versionLabel('dev')).toBe('dev')
    expect(HealthResponse.parse({ status: 'ok', version: '2.0.0', api: API_GENERATION }).api).toBe(
      3,
    )
    expect(HealthResponse.safeParse({ status: 'ok', version: '2.0.0' }).success).toBe(false)
    expect(
      UnavailableHealthResponse.parse({
        status: 'unavailable',
        version: '2.0.0',
        api: API_GENERATION,
        database: 'unavailable',
      }).api,
    ).toBe(3)
    expect(ApplySuggestionResponse.parse({ entry: null }).entry).toBeNull()
    expect(RotateApiKeyRequest.parse({ name: 'New Mac' }).name).toBe('New Mac')
    expect(RebuildEmbeddingsResponse.parse({ queued: 12 }).queued).toBe(12)
    expect(
      DreamEntrySnapshot.parse({
        id: '00000000-0000-4000-8000-000000000001',
        shortId: 'm-234abc',
        kind: 'episode',
        title: '会话摘要',
        content: '单机配置',
        disclosure: null,
        isPinned: false,
        envs: ['mac'],
        realms: [],
        projects: [],
        runtimes: [],
        topics: [],
        deviceKey: 'home-24',
        version: 1,
        updatedAt: '2026-10-01T00:00:00Z',
      }).deviceKey,
    ).toBe('home-24')
    expect(
      BootResponse.parse({
        entries: [
          {
            shortId: 'm-234abc',
            title: '单机规则',
            kind: 'entry',
            content: '内容',
            envs: ['home-24'],
          },
        ],
        omitted: ['m-345bcd'],
        omittedItems: [{ shortId: 'm-345bcd', title: '手册', envs: ['mac'] }],
      }).entries[0]?.envs,
    ).toEqual(['home-24'])
  })

  it('validates single-turn refine capture plans and inbox suggestion revise contracts', () => {
    expect(
      CapturePlanRequest.parse({
        text: '补充说明仅适用于 home-24 主机',
        targetShortId: 'm-234abc',
        mode: 'refine',
      }),
    ).toMatchObject({
      targetShortId: 'm-234abc',
      mode: 'refine',
    })
    expect(
      CapturePlanRequest.safeParse({
        text: '补充说明仅适用于 home-24 主机',
        mode: 'refine',
      }).success,
    ).toBe(false)
    expect(CapturePlanRequest.parse({ text: '普通随手记' }).mode).toBe('auto')

    const parsedPlan = CapturePlanResponse.parse({
      mode: 'llm',
      fallbackReason: null,
      action: 'update',
      patchKind: 'replace',
      patchHeading: null,
      reason: '收紧主机适用边界',
      targetShortId: 'm-234abc',
      targetVersion: 2,
      beforeContent: '旧正文',
      proposedContent: '仅限 home-24 主机的新正文',
      integrity: {
        intact: true,
        linksBefore: 0,
        linksAfter: 0,
        missingLinks: [],
        credsBefore: 0,
        credsAfter: 0,
        missingCreds: [],
        severeShrink: false,
      },
      proposedTitle: 'home-24 本机代理配置',
      proposedSummary: '仅适用于 home-24 局域网主机。',
      proposedDisclosure: '在 home-24 排查代理时参考',
      proposedEnvs: ['HOME-24'],
      proposedProjects: ['kioku'],
      proposedRealms: null,
      proposedRuntimes: [],
      proposedChangeSummary: '限定单机边界',
      proposedNew: {
        title: 'home-24 本机代理配置',
        content: '旧正文',
        disclosure: null,
        topics: [],
        envs: [],
        realms: [],
        projects: [],
        runtimes: [],
        isPinned: false,
      },
      candidates: [],
    })
    expect(parsedPlan.proposedEnvs).toEqual(['home-24'])
    expect(parsedPlan.proposedRuntimes).toEqual([])

    expect(REVISABLE_DREAM_KINDS).toEqual(['distill_episode', 'update', 'merge_duplicates', 'tidy'])
    expect(
      ReviseSuggestionRequest.parse({
        instruction: '  收紧环境标签为 home-24  ',
        envs: ['HOME-24'],
      }),
    ).toMatchObject({
      instruction: '收紧环境标签为 home-24',
      envs: ['home-24'],
    })
    expect(ReviseSuggestionRequest.safeParse({ instruction: '   ' }).success).toBe(false)
    expect(ReviseSuggestionRequest.safeParse({ instruction: '字'.repeat(501) }).success).toBe(false)

    const revised = ReviseSuggestionResponse.parse({
      proposedTitle: 'home-24 本地代理',
      proposedSummary: '仅适用于 home-24 主机',
      proposedContent: '仅限 home-24 生效，端口 7890。',
      proposedDisclosure: '配置 home-24 本地代理时参考',
      proposedChangeSummary: '限定仅适用于 home-24',
      proposedTopics: ['network'],
      proposedEnvs: ['home-24'],
      proposedRealms: ['work'],
      proposedProjects: ['kioku'],
      proposedRuntimes: [],
      proposedBootMode: 'none',
      reason: '已按说明收紧主机适用边界与环境标签',
      integrity: {
        intact: true,
        linksBefore: 0,
        linksAfter: 0,
        missingLinks: [],
        credsBefore: 0,
        credsAfter: 0,
        missingCreds: [],
        severeShrink: false,
      },
    })
    expect(revised.proposedEnvs).toEqual(['home-24'])
  })
})
