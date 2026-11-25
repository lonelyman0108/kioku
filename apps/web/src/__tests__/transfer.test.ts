import { LORE_BACKUP_FORMAT } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { tokenInClear, TransferFileError, trimLoreBackup } from '../transfer'

describe('transfer helpers', () => {
  it('trims Lore backup to 5 tables and strips deprecated memory contents', () => {
    const trimmed = trimLoreBackup({
      format: LORE_BACKUP_FORMAT,
      created_at: '2026-11-24T12:00:00Z',
      tables: {
        nodes: [{ uuid: 'n1', created_at: '2026-11-24T12:00:00Z' }],
        memories: [
          { id: 1, node_uuid: 'n1', deprecated: true, content: 'old-secret' },
          { id: 2, node_uuid: 'n1', deprecated: false, content: 'current-body' },
        ],
        edges: [],
        paths: [],
        glossary_keywords: [],
        app_settings: [{ key: 'openai_key', value: 'sk-secret' }],
      },
    })

    expect(Object.keys(trimmed.tables).sort()).toEqual([
      'edges',
      'glossary_keywords',
      'memories',
      'nodes',
      'paths',
    ])
    expect(trimmed.tables.memories[0]).not.toHaveProperty('content')
    expect(trimmed.tables.memories[1]).toHaveProperty('content', 'current-body')
  })

  it('rejects non-Lore backup JSON', () => {
    expect(() => trimLoreBackup({ format: 'other' })).toThrow(TransferFileError)
  })

  it('flags public http Lore URLs as cleartext while allowing localhost/LAN/https', () => {
    expect(tokenInClear('http://example.com:18901')).toBe(true)
    expect(tokenInClear('https://example.com')).toBe(false)
    expect(tokenInClear('http://127.0.0.1:18901')).toBe(false)
    expect(tokenInClear('http://10.0.0.5:18901')).toBe(false)
    expect(tokenInClear('http://lore-web:18901')).toBe(false)
  })
})
