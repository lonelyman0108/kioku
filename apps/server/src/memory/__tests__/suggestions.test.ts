import { describe, expect, it } from 'vitest'

import { consoleAccess } from '../../access/access'
import type { memories } from '../../db/schema'
import { listable } from '../suggestions'

type Row = typeof memories.$inferSelect

const ALICE = '00000000-0000-0000-0000-0000000000a1'
const BOB = '00000000-0000-0000-0000-0000000000b0'
const NOW = new Date('2026-10-29T12:00:00Z')

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    spaceId: '00000000-0000-0000-0000-000000000005',
    form: 'curated',
    layer: 'base',
    sensitivity: 'public',
    provenance: 'owner',
    originScope: 'global',
    ownerAccountId: null,
    personaId: null,
    appId: null,
    subjectId: null,
    domain: 'core',
    path: id.slice(-4),
    content: '正文',
    ciphertext: null,
    wrappedKey: null,
    keyId: null,
    priority: 2,
    disclosure: null,
    validFrom: new Date('2026-10-01T00:00:00Z'),
    validTo: null,
    expiresAt: null,
    version: 1,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    deletedAt: null,
    fts: '',
    ...overrides,
  }
}

describe('建议列表的第二次查询取到的行', () => {
  const access = consoleAccess('editor', ALICE)
  const a = '00000000-0000-0000-0000-00000000000a'
  const b = '00000000-0000-0000-0000-00000000000b'
  const suggestion = { memoryIds: [a, b], versions: [1, 3] }
  const rows = (overrides: Partial<Row> = {}) =>
    new Map([
      [a, row(a)],
      [b, row(b, { version: 3, ...overrides })],
    ])

  it('每条都还是建议里的那一版、没删除、现在有效、查看者读得到时才列', () => {
    expect(listable(suggestion, rows(), access, NOW)).toBe(true)
  })

  it('两次查询之间改过、删掉、过期、移进了别人的私人层或者清掉了的，这条建议不列', () => {
    expect(listable(suggestion, rows({ version: 4 }), access, NOW)).toBe(false)
    expect(listable(suggestion, rows({ deletedAt: NOW }), access, NOW)).toBe(false)
    expect(listable(suggestion, rows({ validTo: NOW }), access, NOW)).toBe(false)
    expect(listable(suggestion, rows({ layer: 'private', ownerAccountId: BOB }), access, NOW)).toBe(
      false,
    )
    expect(listable(suggestion, new Map([[a, row(a)]]), access, NOW)).toBe(false)
    // 自己的私人层照样读得到
    expect(
      listable(suggestion, rows({ layer: 'private', ownerAccountId: ALICE }), access, NOW),
    ).toBe(true)
  })
})
