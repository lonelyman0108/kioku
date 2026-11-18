import { describe, expect, it } from 'vitest'

import { LORE_IMPORT_UNAVAILABLE } from '../lore'

describe('Lore 备份迁移占位说明', () => {
  it('暴露架构适配中的提示语', () => {
    expect(LORE_IMPORT_UNAVAILABLE).toContain('记忆圈')
  })
})
