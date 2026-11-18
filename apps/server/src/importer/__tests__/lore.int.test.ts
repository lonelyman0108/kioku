import { describe, expect, it } from 'vitest'

import { LORE_IMPORT_UNAVAILABLE } from '../lore'

describe('Lore 导入占位', () => {
  it('返回正在适配记忆圈架构的提示文本', () => {
    expect(LORE_IMPORT_UNAVAILABLE).toBe('Lore 迁入工具正在适配记忆圈架构')
  })
})
