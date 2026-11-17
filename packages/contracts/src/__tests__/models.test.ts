import { describe, expect, it } from 'vitest'

import {
  supportsModelKind,
  UpdateDreamBinding,
  UpdateEmbeddingSettings,
  UpdateExtractionBinding,
  UpdatePrivacyBinding,
  UpsertModelProvider,
} from '../index'

describe('模型配置契约', () => {
  it('协议能力矩阵拒绝不支持嵌入的格式挂载嵌入模型', () => {
    expect(supportsModelKind('anthropic', 'chat')).toBe(true)
    expect(supportsModelKind('anthropic', 'embedding')).toBe(false)
    expect(supportsModelKind('openai-responses', 'embedding')).toBe(false)
    expect(supportsModelKind('gemini', 'embedding')).toBe(true)
    expect(supportsModelKind('ollama', 'embedding')).toBe(true)

    const bad = UpsertModelProvider.safeParse({
      name: 'Claude',
      format: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      profiles: [{ kind: 'embedding', model: 'embed' }],
    })
    expect(bad.success).toBe(false)
  })

  it('校验重复的模型条目编号与绑定重复项', () => {
    const dupProfile = UpsertModelProvider.safeParse({
      name: 'OpenAI',
      format: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      profiles: [
        { id: 'p1', kind: 'chat', model: 'gpt-4o' },
        { id: 'p1', kind: 'embedding', model: 'text-embedding-3-small' },
      ],
    })
    expect(dupProfile.success).toBe(false)

    expect(UpdateExtractionBinding.safeParse({ profileIds: ['p1', 'p1'] }).success).toBe(false)
    expect(UpdateDreamBinding.safeParse({ mode: 'custom', profileIds: ['p1', 'p1'] }).success).toBe(
      false,
    )
    expect(
      UpdateEmbeddingSettings.safeParse({ model: 'm', profileIds: ['p1', 'p1'] }).success,
    ).toBe(false)
    expect(UpdateEmbeddingSettings.safeParse({ model: 'm', profileIds: [] }).success).toBe(false)
  })

  it('隐私绑定按模式校验必填项', () => {
    expect(UpdatePrivacyBinding.safeParse({ mode: 'off' }).success).toBe(true)
    expect(UpdatePrivacyBinding.safeParse({ mode: 'http', baseUrl: '' }).success).toBe(false)
    expect(
      UpdatePrivacyBinding.safeParse({ mode: 'http', baseUrl: 'http://127.0.0.1:8080/detect' })
        .success,
    ).toBe(true)
    expect(UpdatePrivacyBinding.safeParse({ mode: 'model', profileIds: [] }).success).toBe(false)
    expect(UpdatePrivacyBinding.safeParse({ mode: 'model', profileIds: ['p1'] }).success).toBe(true)
  })
})
