import type { ConsoleEntryView, FacetVocabularyView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  BOOT_HINT,
  expiryState,
  isBootNode,
  looksPlaintext,
  missingDisclosure,
  originScopeLabel,
  plaintextValues,
  recallText,
  statsChanged,
  whenLabel,
} from '../memoryDetail'

const now = new Date('2026-10-31T12:00:00.000Z')
const later = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString()

describe('有效期的状态', () => {
  it('没有有效期、还早、七天内、已过期四种', () => {
    expect(expiryState(null, now)).toBe('none')
    expect(expiryState(later(8), now)).toBe('later')
    expect(expiryState(later(7), now)).toBe('soon')
    expect(expiryState(later(0.1), now)).toBe('soon')
    expect(expiryState(later(0), now)).toBe('expired')
    expect(expiryState(later(-1), now)).toBe('expired')
  })
})

describe('启动加载', () => {
  const entry = (extra: object) => ({
    kind: 'entry' as const,
    priority: 0,
    provenance: 'owner' as const,
    sensitivity: 'internal' as const,
    validTo: null,
    ...extra,
  })

  it('和服务端同一个条件：仅正式词条且优先级为 0', () => {
    expect(isBootNode(entry({}), now)).toBe(true)
    expect(isBootNode(entry({ priority: 1 }), now)).toBe(false)
    expect(isBootNode(entry({ priority: 2 }), now)).toBe(false)
  })

  it('来自对话的两类、未确认来源、过期了的都不算', () => {
    expect(isBootNode(entry({ kind: 'fact' }), now)).toBe(false)
    expect(isBootNode(entry({ kind: 'episode' }), now)).toBe(false)
    expect(isBootNode(entry({ provenance: 'untrusted' }), now)).toBe(false)
    expect(isBootNode(entry({ validTo: later(-1) }), now)).toBe(false)
    expect(isBootNode(entry({ validTo: later(1) }), now)).toBe(true)
  })

  it('机密永远不进启动加载，哪怕优先级够', () => {
    expect(isBootNode(entry({ sensitivity: 'secret' }), now)).toBe(false)
    expect(isBootNode(entry({ sensitivity: 'private' }), now)).toBe(true)
  })

  it('提示层说的是够格，不是一定加载', () => {
    expect(BOOT_HINT).toContain('符合启动加载条件')
    expect(BOOT_HINT).toContain('访问密钥的透镜权限、切面匹配和字数上限')
  })
})

describe('没写触发场景时的提示', () => {
  const entry = (extra: object) => ({
    disclosure: null,
    kind: 'entry' as const,
    priority: 2,
    provenance: 'owner' as const,
    sensitivity: 'internal' as const,
    validTo: null,
    ...extra,
  })

  const tone = (extra: object) => missingDisclosure(entry(extra), now)?.tone ?? null

  it('写了就不提示，只有空白的算没写', () => {
    expect(missingDisclosure(entry({ disclosure: '讨论发布时' }), now)).toBeNull()
    expect(tone({ disclosure: '  ' })).toBe('warning')
    expect(tone({})).toBe('warning')
  })

  it('启动加载的词条不算要补的，语气弱一点：概览的「未设触发场景」不数它们', () => {
    expect(tone({ priority: 0 })).toBe('muted')
  })

  it('机密够不上启动加载，照常警告', () => {
    expect(tone({ priority: 0, sensitivity: 'secret' })).toBe('warning')
  })

  it('说明跟着情况换：只有走召回的才说召回更准', () => {
    expect(missingDisclosure(entry({}), now)!.hint).toBe('补全后召回更准确。')
    const boot = missingDisclosure(entry({ priority: 0 }), now)!
    expect(boot.hint).toContain('未被加载时')
    expect(boot.hint).not.toContain(boot.text)
    const secret = missingDisclosure(entry({ sensitivity: 'secret' }), now)!.hint
    expect(secret).toContain('机密内容不参与召回')
    expect(secret).not.toContain('召回更准确')
    expect(missingDisclosure(entry({ priority: 0, sensitivity: 'secret' }), now)!.hint).toBe(secret)
  })

  it('启动加载的词条写明是启动加载，要补的写「未设触发场景」', () => {
    expect(missingDisclosure(entry({}), now)).toMatchObject({
      tone: 'warning',
      text: '未设触发场景',
      short: '未设触发场景',
    })
    expect(missingDisclosure(entry({ priority: 0 }), now)).toMatchObject({
      tone: 'muted',
      text: '启动加载不依赖触发场景',
      short: '启动加载',
    })
    expect(missingDisclosure(entry({ priority: 0, sensitivity: 'secret' }), now)!.short).toBe(
      '未设触发场景',
    )
  })
})

describe('疑似明文（多变体切片）', () => {
  const variant = (content: string | null, plaintextIgnored = false) => ({
    id: '00000000-0000-4000-8000-0000000000a1',
    when: {},
    whenSignature: '{}',
    sortOrder: 0,
    content,
    updatedAt: later(-1),
    contentHidden: content === null,
    plaintextIgnored,
  })
  const entry = (
    over: Partial<{
      content: string | null
      sensitivity: 'public' | 'internal' | 'private' | 'secret'
      plaintextIgnored: boolean
      variants: ReturnType<typeof variant>[]
    }> = {},
  ) => ({
    sensitivity: over.sensitivity ?? ('private' as const),
    plaintextIgnored: over.plaintextIgnored ?? false,
    variants: over.variants ?? [
      variant('content' in over ? (over.content ?? null) : '密码：hunter2-not-real'),
    ],
  })

  it('取出多个未忽略切片里的疑似明文值并去重', () => {
    const multi = entry({
      variants: [
        variant('密码：hunter2-not-real'),
        variant('token=abcd1234 密码：hunter2-not-real'),
      ],
    })
    expect(looksPlaintext(multi)).toBe(true)
    expect(plaintextValues(multi)).toEqual(['hunter2-not-real', 'abcd1234'])
  })

  it('值太短时提示还在，但不按字面标：不能把全文的 1 都标红', () => {
    const short = entry({ content: '密码：1\n\n第 1 步，第 11 条。' })
    expect(looksPlaintext(short)).toBe(true)
    expect(plaintextValues(short)).toEqual([])
    expect(plaintextValues(entry({ content: '密码：abc' }))).toEqual([])
    expect(plaintextValues(entry({ content: '密码：abcd' }))).toEqual(['abcd'])
  })

  it('机密、整条或全部切片被忽略、没有正文、只有占位符的都不提示', () => {
    expect(plaintextValues(entry({ sensitivity: 'secret' }))).toEqual([])
    expect(plaintextValues(entry({ plaintextIgnored: true }))).toEqual([])
    expect(plaintextValues(entry({ variants: [variant('密码：hunter22', true)] }))).toEqual([])
    expect(plaintextValues(entry({ content: null }))).toEqual([])
    expect(plaintextValues(entry({ content: '密码：{{cred:nas#password}}' }))).toEqual([])
    expect(looksPlaintext(entry({ content: '说明文字' }))).toBe(false)
  })
})

describe('来源范围与切面标签', () => {
  const clientName = (id: string) => (id === 'c1' ? 'Claude Code' : undefined)

  it('全局和带名字的接入实例', () => {
    expect(originScopeLabel('global', clientName)).toBe('全局')
    expect(originScopeLabel('client:c1', clientName)).toBe('接入实例「Claude Code」')
    expect(originScopeLabel('client:c2', clientName)).toBe('接入实例')
    expect(originScopeLabel('group:g1', clientName)).toBe('群聊')
    expect(originScopeLabel('direct:s1', clientName)).toBe('私聊')
    expect(originScopeLabel('other', clientName)).toBe('other')
  })

  it('切面条件格式化优先使用词表显示名，默认切片给出清晰名称', () => {
    const vocab = {
      circleId: 'c1',
      dimensions: [
        {
          key: 'realm',
          name: '场域',
          matchMode: 'exclusive',
          builtin: true,
          autoRegister: false,
          description: null,
        },
        {
          key: 'project',
          name: '项目',
          matchMode: 'additive',
          builtin: true,
          autoRegister: true,
          description: null,
        },
      ],
      terms: [
        {
          id: 't1',
          circleId: 'c1',
          dimensionKey: 'realm',
          slug: 'work',
          label: '公司',
          implies: {},
          aliases: [],
          autoRegistered: false,
          createdAt: later(-1),
          updatedAt: later(-1),
        },
      ],
    } as FacetVocabularyView
    expect(whenLabel({}, vocab)).toBe('默认（无条件）')
    expect(whenLabel({ project: ['kioku'], realm: ['work'] }, vocab)).toBe(
      '项目: kioku · 场域: 公司',
    )
    expect(whenLabel({ realm: ['home'], env: ['macos'] })).toBe('环境与设备: macos · 场域: home')
  })
})

describe('召回的说法', () => {
  const plain = { secret: false, boot: false }
  const stat = { total: 37, recent: 12, lastRecalledAt: later(-1) }

  it('有次数时写次数和最近一次', () => {
    expect(recallText(stat, plain, now)).toBe('37 次（保留期内 12 次），最近 1 天前')
    expect(recallText({ ...stat, lastRecalledAt: null }, plain, now)).toBe(
      '37 次（保留期内 12 次）',
    )
  })

  it('机密不进召回，缓存里留着次数也不显示', () => {
    expect(recallText(stat, { secret: true, boot: false }, now)).toBe('机密内容不参与召回')
  })

  it('启动加载的词条没有次数时只说够格，有次数时照写', () => {
    const none = { total: 0, recent: 0, lastRecalledAt: null }
    expect(recallText(none, { secret: false, boot: true }, now)).toBe('符合启动加载条件')
    expect(recallText(stat, { secret: false, boot: true }, now)).toContain('37 次')
    expect(recallText(none, plain, now)).toBe('尚未召回')
  })

  it('还没读到时不下结论', () => {
    expect(recallText(undefined, plain, now)).toBe('–')
  })
})

describe('这次改动动没动统计', () => {
  const view = (
    extra: Partial<ConsoleEntryView> & { content?: string | null } = {},
  ): ConsoleEntryView => {
    const { content, ...rest } = extra
    return {
      id: '00000000-0000-4000-8000-000000000001',
      shortId: 'm-234567',
      circleId: '00000000-0000-4000-8000-0000000000c1',
      circleSlug: 'personal',
      kind: 'entry',
      title: '笔记',
      sensitivity: 'internal',
      provenance: 'owner',
      originScope: 'global',
      topics: [],
      realms: [],
      priority: 2,
      disclosure: '讨论时',
      glossary: [],
      validFrom: later(-9),
      validTo: null,
      version: 1,
      variants: [
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          when: {},
          whenSignature: '{}',
          sortOrder: 0,
          content: content === undefined ? '正文' : content,
          updatedAt: later(-9),
          contentHidden: false,
          plaintextIgnored: false,
        },
      ],
      otherVariants: [],
      links: [],
      createdAt: later(-9),
      updatedAt: later(-9),
      contentHidden: false,
      plaintextIgnored: false,
      ...rest,
    }
  }

  it('只改正文、标题、优先级、关键词、触发场景的文字时不动', () => {
    const before = view()
    for (const after of [
      view({ content: '别的正文', version: 2 }),
      view({ title: '别的标题', version: 2 }),
      view({ priority: 1, version: 2 }),
      view({ glossary: ['关键词'], version: 2 }),
      view({ disclosure: '换一种说法', version: 2 }),
      view({ validTo: new Date(Date.now() + 3 * 86_400_000).toISOString(), version: 2 }),
    ]) {
      expect(statsChanged(before, after)).toBe(false)
    }
  })

  it('记忆圈、物种、敏感级、有没有写触发场景、是不是疑似明文变了就动', () => {
    const before = view()
    for (const after of [
      view({ circleId: '00000000-0000-4000-8000-0000000000c2' }),
      view({ kind: 'fact' }),
      view({ sensitivity: 'private' }),
      view({ disclosure: null }),
      view({ disclosure: '  ' }),
      view({ content: '密码：not-a-real-secret' }),
      view({ id: '00000000-0000-4000-8000-000000000002' }),
      view({ validTo: later(-1) }),
    ]) {
      expect(statsChanged(before, after)).toBe(true)
    }
    expect(statsChanged(view({ disclosure: null }), view())).toBe(true)
  })

  it('忽略了明文提示也算', () => {
    const plain = view({ content: '密码：not-a-real-secret' })
    expect(statsChanged(plain, { ...plain, plaintextIgnored: true })).toBe(true)
  })

  it('没写触发场景时看要不要补：改优先级进出启动加载就动，启动加载的词条补上触发场景不动', () => {
    const unset = view({ disclosure: null })
    expect(statsChanged(unset, view({ disclosure: null, priority: 0, version: 2 }))).toBe(true)
    expect(statsChanged(unset, view({ disclosure: null, priority: 1, version: 2 }))).toBe(false)
    const boot = view({ disclosure: null, priority: 0 })
    expect(statsChanged(boot, view({ priority: 0, version: 2 }))).toBe(false)
    expect(statsChanged(boot, view({ disclosure: null, priority: 2, version: 2 }))).toBe(true)
  })
})
