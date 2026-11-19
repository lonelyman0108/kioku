import type { ConsoleEntryView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  hiddenAgain,
  revealedAfterWrite,
  revealedFromEntry,
  stillRevealed,
  withRevealed,
} from '../secretContent'

const view = (extra: Partial<ConsoleEntryView> = {}): ConsoleEntryView => ({
  id: '00000000-0000-4000-8000-000000000001',
  shortId: 'm-234567',
  circleId: '00000000-0000-4000-8000-0000000000c1',
  circleSlug: 'personal',
  kind: 'entry',
  title: '家里的网络',
  sensitivity: 'secret',
  provenance: 'owner',
  originScope: 'global',
  topics: ['infra'],
  realms: ['home'],
  priority: 2,
  disclosure: null,
  glossary: [],
  validFrom: '2026-10-31T00:00:00.000Z',
  validTo: null,
  version: 3,
  variants: [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      when: {},
      whenSignature: '{}',
      sortOrder: 0,
      content: null,
      updatedAt: '2026-10-31T00:00:00.000Z',
      contentHidden: true,
      plaintextIgnored: false,
    },
    {
      id: '00000000-0000-4000-8000-0000000000a2',
      when: { env: ['macos'] },
      whenSignature: '{"env":["macos"]}',
      sortOrder: 1,
      content: null,
      updatedAt: '2026-10-31T00:00:00.000Z',
      contentHidden: true,
      plaintextIgnored: false,
    },
  ],
  otherVariants: [],
  links: [],
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  contentHidden: true,
  plaintextIgnored: false,
  ...extra,
})

describe('查看过的机密正文', () => {
  const revealed = {
    id: '00000000-0000-4000-8000-000000000001',
    version: 3,
    variantsBySig: {
      '{}': '默认正文',
      '{"env":["macos"]}': 'Mac 正文',
    },
  }

  it('同一条、同一版才配上去，按切片签名还原所有变体', () => {
    const shown = withRevealed(view(), revealed)
    expect(shown.contentHidden).toBe(false)
    expect(shown.variants.map((v) => [v.content, v.contentHidden])).toEqual([
      ['默认正文', false],
      ['Mac 正文', false],
    ])
    expect(withRevealed(view({ version: 4 }), revealed).contentHidden).toBe(true)
    expect(withRevealed(view({ id: 'other-id' }), revealed).contentHidden).toBe(true)
    expect(withRevealed(view(), null).contentHidden).toBe(true)
  })

  it('服务器给了正文的不动：不是机密，或者就是查看的响应', () => {
    const base = view()
    const open = view({
      sensitivity: 'private',
      contentHidden: false,
      variants: base.variants.map((v) => ({ ...v, content: '公开的', contentHidden: false })),
    })
    expect(withRevealed(open, revealed)).toBe(open)
    expect(revealedFromEntry(open)).toEqual({
      id: open.id,
      version: 3,
      variantsBySig: {
        '{}': '公开的',
        '{"env":["macos"]}': '公开的',
      },
    })
  })

  it('版本变了就不再算查看过', () => {
    expect(stillRevealed(view(), revealed)).toBe(true)
    expect(stillRevealed(view({ version: 4 }), revealed)).toBe(false)
    expect(stillRevealed(view(), null)).toBe(false)
  })

  it('保存之后机密的正文就是刚写的，降级之后服务器照常给，不用留', () => {
    const next = view({ version: 4 })
    expect(
      revealedAfterWrite(next, [
        { when: {}, content: '新的默认' },
        { when: { env: ['macos'] }, content: '新的 Mac' },
      ]),
    ).toEqual({
      id: next.id,
      version: 4,
      variantsBySig: {
        '{}': '新的默认',
        '{"env":["macos"]}': '新的 Mac',
      },
    })
    expect(
      revealedAfterWrite(view({ sensitivity: 'private', contentHidden: false }), [
        { when: {}, content: '新的' },
      ]),
    ).toBeNull()
  })

  it('收起之后所有切片正文不在了，这一版不变，要再查看一次', () => {
    const shown = withRevealed(view(), revealed)
    expect(shown.contentHidden).toBe(false)
    const hidden = hiddenAgain(shown)
    expect(hidden.contentHidden).toBe(true)
    expect(hidden.variants.every((v) => v.content === null && v.contentHidden)).toBe(true)
    expect(withRevealed(hidden, null)).toEqual(hidden)
  })
})
