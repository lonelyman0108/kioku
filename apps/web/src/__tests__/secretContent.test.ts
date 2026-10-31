import type { ConsoleMemoryView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { revealedAfterWrite, stillRevealed, withRevealed } from '../secretContent'

const view = (extra: Partial<ConsoleMemoryView> = {}): ConsoleMemoryView => ({
  id: 'm1',
  uri: 'home://wifi',
  layer: 'private',
  sensitivity: 'secret',
  provenance: 'owner',
  originScope: 'global',
  content: null,
  priority: 2,
  disclosure: null,
  glossary: [],
  validFrom: '2026-10-31T00:00:00.000Z',
  validTo: null,
  version: 3,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  contentHidden: true,
  plaintextIgnored: false,
  ...extra,
})

describe('查看过的机密正文', () => {
  const revealed = { id: 'm1', version: 3, content: '正文' }

  it('同一条、同一版才配上去', () => {
    expect(withRevealed(view(), revealed)).toMatchObject({ content: '正文', contentHidden: false })
    expect(withRevealed(view({ version: 4 }), revealed)).toMatchObject({
      content: null,
      contentHidden: true,
    })
    expect(withRevealed(view({ id: 'm2' }), revealed)).toMatchObject({
      content: null,
      contentHidden: true,
    })
    expect(withRevealed(view(), null)).toMatchObject({ content: null, contentHidden: true })
  })

  it('服务器给了正文的不动：不是机密，或者就是查看的响应', () => {
    const open = view({ sensitivity: 'private', content: '公开的', contentHidden: false })
    expect(withRevealed(open, revealed)).toBe(open)
  })

  it('版本变了就不再算查看过', () => {
    expect(stillRevealed(view(), revealed)).toBe(true)
    expect(stillRevealed(view({ version: 4 }), revealed)).toBe(false)
    expect(stillRevealed(view(), null)).toBe(false)
  })

  it('保存之后机密的正文就是刚写的，降级之后服务器照常给，不用留', () => {
    expect(revealedAfterWrite(view({ version: 4 }), '新的')).toEqual({
      id: 'm1',
      version: 4,
      content: '新的',
    })
    expect(
      revealedAfterWrite(
        view({ sensitivity: 'private', content: '新的', contentHidden: false }),
        '新的',
      ),
    ).toBeNull()
  })
})
