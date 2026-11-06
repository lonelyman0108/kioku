import type { ConsoleMemoryView, PersonaDetail } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  BOOT_HINT,
  expiryState,
  isBootNode,
  looksPlaintext,
  missingDisclosure,
  originScopeLabel,
  overriddenNode,
  plaintextValues,
  recallText,
  statsChanged,
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
  const memory = (extra: object) => ({
    layer: 'private' as const,
    priority: 0,
    provenance: 'owner' as const,
    sensitivity: 'internal' as const,
    validTo: null,
    ...extra,
  })

  it('和服务端同一个条件：优先级 0，人格和应用层到优先级 1', () => {
    expect(isBootNode(memory({}), now)).toBe(true)
    expect(isBootNode(memory({ priority: 1 }), now)).toBe(false)
    expect(isBootNode(memory({ layer: 'persona', priority: 1 }), now)).toBe(true)
    expect(isBootNode(memory({ layer: 'app', priority: 1 }), now)).toBe(true)
    expect(isBootNode(memory({ layer: 'app', priority: 2 }), now)).toBe(false)
  })

  it('来自对话的两层、未确认来源、过期了的都不算', () => {
    expect(isBootNode(memory({ layer: 'subject' }), now)).toBe(false)
    expect(isBootNode(memory({ layer: 'episode' }), now)).toBe(false)
    expect(isBootNode(memory({ provenance: 'untrusted' }), now)).toBe(false)
    expect(isBootNode(memory({ validTo: later(-1) }), now)).toBe(false)
    expect(isBootNode(memory({ validTo: later(1) }), now)).toBe(true)
  })

  it('机密永远不进启动加载，哪怕优先级够', () => {
    expect(isBootNode(memory({ sensitivity: 'secret' }), now)).toBe(false)
    expect(isBootNode(memory({ sensitivity: 'secret', layer: 'persona' }), now)).toBe(false)
    expect(isBootNode(memory({ sensitivity: 'private' }), now)).toBe(true)
  })

  it('提示层说的是够格，不是一定加载', () => {
    expect(BOOT_HINT).toContain('符合启动加载条件')
    expect(BOOT_HINT).toContain('访问密钥的权限、继承覆盖和字数上限')
  })
})

describe('没写触发场景时的提示', () => {
  const memory = (extra: object) => ({
    disclosure: null,
    layer: 'private' as const,
    priority: 2,
    provenance: 'owner' as const,
    sensitivity: 'internal' as const,
    validTo: null,
    ...extra,
  })

  const tone = (extra: object) => missingDisclosure(memory(extra), now)?.tone ?? null

  it('写了就不提示，只有空白的算没写', () => {
    expect(missingDisclosure(memory({ disclosure: '讨论发布时' }), now)).toBeNull()
    expect(tone({ disclosure: '  ' })).toBe('warning')
    expect(tone({})).toBe('warning')
  })

  it('启动加载的节点也提示，和概览的数字对得上，只是语气弱一点', () => {
    expect(tone({ priority: 0 })).toBe('muted')
    expect(tone({ layer: 'persona', priority: 1 })).toBe('muted')
  })

  it('机密够不上启动加载，照常警告', () => {
    expect(tone({ priority: 0, sensitivity: 'secret' })).toBe('warning')
  })

  it('说明跟着情况换：只有走召回的才说召回更准', () => {
    expect(missingDisclosure(memory({}), now)!.hint).toBe('补全后召回更准确。')
    const boot = missingDisclosure(memory({ priority: 0 }), now)!
    expect(boot.hint).toContain('未被加载时')
    // 「启动加载不依赖触发场景」已经写在提示上，说明里不再重复
    expect(boot.hint).not.toContain(boot.text)
    const secret = missingDisclosure(memory({ sensitivity: 'secret' }), now)!.hint
    expect(secret).toContain('机密内容不参与召回')
    expect(secret).not.toContain('召回更准确')
    // 优先级够启动加载的机密也不进启动加载，按机密说
    expect(missingDisclosure(memory({ priority: 0, sensitivity: 'secret' }), now)!.hint).toBe(
      secret,
    )
  })

  it('启动加载的节点写明是启动加载，要补的写「未设触发场景」：两种文字不同，不只靠颜色区分', () => {
    expect(missingDisclosure(memory({}), now)).toMatchObject({
      tone: 'warning',
      text: '未设触发场景',
      short: '未设触发场景',
    })
    expect(missingDisclosure(memory({ priority: 0 }), now)).toMatchObject({
      tone: 'muted',
      text: '启动加载不依赖触发场景',
      short: '启动加载',
    })
    expect(missingDisclosure(memory({ layer: 'persona', priority: 1 }), now)!.short).toBe(
      '启动加载',
    )
    // 机密够不上启动加载，照常要补
    expect(missingDisclosure(memory({ priority: 0, sensitivity: 'secret' }), now)!.short).toBe(
      '未设触发场景',
    )
  })
})

describe('疑似明文', () => {
  const memory = (extra: object) => ({
    content: '密码：hunter2-not-real',
    sensitivity: 'private' as const,
    plaintextIgnored: false,
    ...extra,
  })

  it('取出值，要在正文里标出来', () => {
    expect(plaintextValues(memory({}))).toEqual(['hunter2-not-real'])
    expect(looksPlaintext(memory({}))).toBe(true)
  })

  it('值太短时提示还在，但不按字面标：不能把全文的 1 都标红', () => {
    const short = memory({ content: '密码：1\n\n第 1 步，第 11 条。' })
    expect(looksPlaintext(short)).toBe(true)
    expect(plaintextValues(short)).toEqual([])
    expect(plaintextValues(memory({ content: '密码：abc' }))).toEqual([])
    expect(plaintextValues(memory({ content: '密码：abcd' }))).toEqual(['abcd'])
  })

  it('机密、提示被忽略、没有正文、只有占位符的都不提示', () => {
    expect(plaintextValues(memory({ sensitivity: 'secret' }))).toEqual([])
    expect(plaintextValues(memory({ plaintextIgnored: true }))).toEqual([])
    expect(plaintextValues(memory({ content: null }))).toEqual([])
    expect(plaintextValues(memory({ content: '密码：{{cred:nas#password}}' }))).toEqual([])
    expect(looksPlaintext(memory({ content: '说明文字' }))).toBe(false)
  })
})

describe('人格覆盖', () => {
  const detail = {
    ancestors: [{ id: 'p1', name: '小满' }],
    inherited: [
      { uri: 'persona://xiaoman/voice', personaId: 'p1', overriddenBy: 'persona://group/voice' },
      { uri: 'persona://xiaoman/soul', personaId: 'p1', overriddenBy: null },
    ],
  } as unknown as PersonaDetail

  it('从祖先的节点反查：说清覆盖了谁的哪个节点', () => {
    expect(overriddenNode(detail, 'persona://group/voice')).toEqual({
      uri: 'persona://xiaoman/voice',
      persona: '小满',
    })
  })

  it('没有覆盖任何节点、还没读到时都没有', () => {
    expect(overriddenNode(detail, 'persona://group/other')).toBeNull()
    expect(overriddenNode(undefined, 'persona://group/voice')).toBeNull()
  })

  it('祖先的名字查不到时也说得出来', () => {
    expect(overriddenNode({ ...detail, ancestors: [] }, 'persona://group/voice')?.persona).toBe(
      '祖先人格',
    )
  })
})

describe('来源范围', () => {
  const appName = (id: string) => (id === 'a1' ? 'Claude Code' : undefined)

  it('全局和带名字的应用', () => {
    expect(originScopeLabel('global', appName)).toBe('全局')
    expect(originScopeLabel('app:a1', appName)).toBe('应用「Claude Code」')
  })

  it('应用删掉了或还没读到时不瞎说名字，不认识的原样给', () => {
    expect(originScopeLabel('app:a2', appName)).toBe('应用')
    expect(originScopeLabel('group:g1', appName)).toBe('群聊')
    expect(originScopeLabel('direct:s1', appName)).toBe('私聊')
    expect(originScopeLabel('other', appName)).toBe('other')
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

  it('启动加载的节点没有次数时只说够格，有次数时照写', () => {
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
  const view = (extra: Partial<ConsoleMemoryView> = {}): ConsoleMemoryView => ({
    id: 'm1',
    uri: 'notes://a',
    layer: 'private',
    sensitivity: 'internal',
    provenance: 'owner',
    originScope: 'global',
    content: '正文',
    priority: 2,
    disclosure: '讨论时',
    glossary: [],
    validFrom: later(-9),
    validTo: null,
    version: 1,
    createdAt: later(-9),
    updatedAt: later(-9),
    contentHidden: false,
    plaintextIgnored: false,
    ...extra,
  })

  it('只改正文、优先级、关键词、触发场景的文字时不动', () => {
    const before = view()
    for (const after of [
      view({ content: '别的正文', version: 2 }),
      view({ priority: 0, version: 2 }),
      view({ glossary: ['关键词'], version: 2 }),
      view({ disclosure: '换一种说法', version: 2 }),
      // statsChanged 按真实时间判断是否过期，这里的有效期也要按真实时间往后推
      view({ validTo: new Date(Date.now() + 3 * 86_400_000).toISOString(), version: 2 }),
    ]) {
      expect(statsChanged(before, after)).toBe(false)
    }
  })

  it('层、敏感级、有没有写触发场景、是不是疑似明文变了就动', () => {
    const before = view()
    for (const after of [
      view({ layer: 'owner' }),
      view({ sensitivity: 'private' }),
      view({ disclosure: null }),
      view({ disclosure: '  ' }),
      view({ content: '密码：not-a-real-secret' }),
      view({ id: 'm2' }),
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

  it('没写触发场景时看要不要补：改优先级进出启动加载就动，启动加载的节点补上触发场景不动', () => {
    const unset = view({ disclosure: null })
    expect(statsChanged(unset, view({ disclosure: null, priority: 0, version: 2 }))).toBe(true)
    expect(statsChanged(unset, view({ disclosure: null, priority: 1, version: 2 }))).toBe(false)
    const boot = view({ disclosure: null, priority: 0 })
    expect(statsChanged(boot, view({ priority: 0, version: 2 }))).toBe(false)
    expect(statsChanged(boot, view({ disclosure: null, priority: 2, version: 2 }))).toBe(true)
  })
})
