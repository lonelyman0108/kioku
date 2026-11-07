import { describe, expect, it, vi } from 'vitest'

import { plaintextSpots, type LoreNode } from '../../importer/lore'
import { conversionsOf } from '../loreImport'

vi.mock('../../importer/lore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../importer/lore')>()
  return { ...actual, plaintextSpots: vi.fn(actual.plaintextSpots) }
})

const node = (uri: string, content: string): LoreNode => ({
  uuid: `uuid-${uri}`,
  uri,
  aliases: [`${uri}-alias`],
  priority: 2,
  disclosure: null,
  content,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  previousVersions: 0,
  keywords: [],
})

const ID = '00000000-0000-4000-8000-000000000001'

describe('要换成占位符的几处', () => {
  it('只扫点到的节点，同一个节点（主路径与别名）只扫一次', () => {
    const snapshot = {
      nodes: [
        node('infra://a', 'password: aaaa-1111\ntoken = bbbb-2222'),
        node('infra://b', 'password: cccc-3333'),
        node('infra://c', 'password: dddd-4444'),
      ],
      recallEvents: null,
    }
    const known = {
      entries: [{ id: ID, identifier: 'a', name: 'A', field: 'password', value: 'aaaa-1111' }],
      unconvertible: new Set<string>(),
      unresolved: new Map(),
      unavailableConnections: 0,
      unreadableCredentials: 0,
    }
    vi.mocked(plaintextSpots).mockClear()
    const out = conversionsOf(snapshot, known, [
      { source: 'infra://a', index: 0, credentialId: ID, field: 'password' },
      { source: 'infra://a-alias', index: 1, credentialId: ID, field: 'password' },
    ])
    expect(vi.mocked(plaintextSpots)).toHaveBeenCalledTimes(1)
    expect(out.get('uuid-infra://a')).toEqual([
      { line: 1, value: 'aaaa-1111', credential: { identifier: 'a', field: 'password' } },
      { line: 2, value: 'bbbb-2222', credential: null, problem: 'stale' },
    ])
  })
})
