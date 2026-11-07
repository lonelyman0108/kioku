import type { InboxCounts } from '@kioku/contracts'
import { QueryClient } from '@tanstack/vue-query'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import {
  INBOX_TABS,
  actionableInboxCount,
  attentionCredentialsKey,
  inboxCountsKey,
  inboxTabActionable,
  inboxTabCount,
  inboxTabLabels,
  legacyReviewTab,
  refreshInbox,
  resolveInboxTab,
} from '../inbox'
import inboxPage from '../pages/InboxPage.vue?raw'

const counts = (over: Partial<InboxCounts> = {}): InboxCounts => ({
  bindings: 0,
  review: 0,
  dreamSuggestions: 0,
  plaintext: 0,
  credentials: 0,
  total: 0,
  ...over,
})

describe('看的是哪一类', () => {
  it('地址里写了就看那一类，哪怕它是空的', () => {
    expect(resolveInboxTab('dream', counts({ review: 3 }), false)).toBe('dream')
    expect(resolveInboxTab('binding', undefined, false)).toBe('binding')
  })

  it('没写或者写错时看第一个有内容的，顺序和左边一样', () => {
    expect(resolveInboxTab(undefined, counts({ plaintext: 2, dreamSuggestions: 1 }), false)).toBe(
      'dream',
    )
    expect(resolveInboxTab('nope', counts({ bindings: 1, review: 1 }), false)).toBe('binding')
  })

  it('都是空的时候看待确认内容', () => {
    expect(resolveInboxTab(undefined, counts(), false)).toBe('review')
  })

  it('条数还没读到时先不决定，不闪一下别的分类；读取失败时不再等', () => {
    expect(resolveInboxTab(undefined, undefined, false)).toBeNull()
    expect(resolveInboxTab(undefined, undefined, true)).toBe('review')
  })
})

describe('角标的数字', () => {
  const all = counts({ bindings: 1, review: 2, dreamSuggestions: 3, plaintext: 4, total: 10 })

  it('所有者和编辑者是总数', () => {
    expect(actionableInboxCount(all, 'owner')).toBe(10)
    expect(actionableInboxCount(all, 'editor')).toBe(10)
  })

  it('查看者只算账号绑定：这一类他能拒绝，别的几类动不了，算进去永远消不掉', () => {
    expect(actionableInboxCount(all, 'viewer')).toBe(1)
    expect(actionableInboxCount(counts({ review: 5, total: 5 }), 'viewer')).toBe(0)
  })
})

describe('旧地址', () => {
  it('review 的两个分页对应到这里', () => {
    expect(legacyReviewTab('dream')).toBe('dream')
    expect(legacyReviewTab(undefined)).toBe('review')
    expect(legacyReviewTab('whatever')).toBe('review')
  })
})

describe('五类', () => {
  it('每一类的条数取对字段，名字都有', () => {
    const all = counts({
      bindings: 1,
      review: 2,
      dreamSuggestions: 3,
      plaintext: 4,
      credentials: 5,
    })
    expect(INBOX_TABS.map((t) => inboxTabCount(all, t))).toEqual([1, 2, 3, 4, 5])
    for (const t of INBOX_TABS) expect(inboxTabLabels[t]).toBeTruthy()
  })

  it('缓存键带空间', () => {
    expect(inboxCountsKey('s1')).toEqual(['inbox-counts', 's1'])
  })
})

describe('待处理页', () => {
  it('标题的大数字和导航角标、概览同一个口径；角色读到之前不知道口径，先写「–」', () => {
    const script = parse(inboxPage).descriptor.scriptSetup!.content
    expect(script).toContain(
      'counts.data.value && role.value ? actionableInboxCount(counts.data.value, role.value) : null',
    )
    expect(inboxPage).toContain(`<span class="inbox-total">{{ total ?? '–' }}</span>`)
    expect(inboxPage).not.toContain('counts.data.value?.total')
  })

  it('各分类照常写各自的条数：0 不醒目，处理不了的那几类等角色读到再定，也一样不醒目', () => {
    const script = parse(inboxPage).descriptor.scriptSetup!.content
    expect(inboxPage).toContain('inboxTabCount(counts.data.value, t)')
    expect(inboxPage).toContain(`<b :class="{ none: quiet(t) }">`)
    expect(script).toContain('!inboxTabCount(counts.data.value, tab)')
    expect(script).toContain('(role.value !== undefined && !inboxTabActionable(tab, role.value))')
    // 选中的那一类反白时也退一级
    expect(inboxPage).toContain(".inbox-tab[aria-current='page'] b.none {")
  })

  it('查看者看到的总数只算能处理的：只有待确认内容时是 0，分类里照样写 7', () => {
    const viewer = counts({ review: 7, total: 7 })
    expect(actionableInboxCount(viewer, 'viewer')).toBe(0)
    expect(inboxTabCount(viewer, 'review')).toBe(7)
  })

  it('能处理的分类：查看者只有账号绑定，凭据只有空间所有者；和总数同一个口径', () => {
    for (const tab of INBOX_TABS) {
      expect(inboxTabActionable(tab, 'owner')).toBe(true)
      expect(inboxTabActionable(tab, 'editor')).toBe(tab !== 'credential')
      expect(inboxTabActionable(tab, 'viewer')).toBe(tab === 'binding')
    }
    const all = counts({
      bindings: 1,
      review: 2,
      dreamSuggestions: 3,
      plaintext: 4,
      credentials: 5,
      total: 15,
    })
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      const sum = INBOX_TABS.filter((t) => inboxTabActionable(t, role))
        .map((t) => inboxTabCount(all, t))
        .reduce((a, b) => a + b, 0)
      expect(actionableInboxCount(all, role)).toBe(sum)
    }
  })

  it('整理建议每张卡的操作都是线框，和其他三类一样；确认对话框里的按钮保持实心', () => {
    const actions =
      /<div v-if="canAct && item\.actionable" class="suggestion-actions">[^]*?\n {8}<\/div>/.exec(
        dreamSuggestions,
      )![0]
    const buttons = actions.match(/<UButton[^>]*>/g)!
    expect(buttons.length).toBeGreaterThanOrEqual(3)
    for (const button of buttons) expect(button).toContain('variant="outline"')
    const dialog = /<UModal[^]*?<\/UModal>/.exec(dreamSuggestions)![0]
    const confirm = dialog.match(/<UButton[^>]*>/g)!.find((b) => b.includes('apply(confirming)'))!
    expect(confirm).not.toContain('variant=')
  })
})

describe('凭据一类', () => {
  it('只有空间所有者算进角标：凭据只有空间所有者改得了', () => {
    const only = counts({ credentials: 2, total: 2 })
    expect(actionableInboxCount(only, 'owner')).toBe(2)
    expect(actionableInboxCount(only, 'editor')).toBe(0)
    expect(actionableInboxCount(only, 'viewer')).toBe(0)
    expect(inboxTabLabels.credential).toBe('凭据')
  })

  it('列表的缓存键和凭据列表同一个前缀：凭据页让 credentials 失效时一起重取', () => {
    expect(attentionCredentialsKey('s1').slice(0, 2)).toEqual(['credentials', 's1'])
  })

  it('手动刷新时凭据的列表一起重取', async () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await refreshInbox(client, 's1')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credentials', 's1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inbox-counts', 's1'] })
  })
})
