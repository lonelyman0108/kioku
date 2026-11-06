import { URI_PATTERN } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SENSITIVITY,
  coordinateHead,
  draftFromKey,
  draftFromUri,
  draftProblem,
  draftUri,
  formatCoordinate,
  identifierFromTitle,
  identifierOf,
  layerOfUri,
  memoryTitle,
  parseCoordinate,
  type CoordinateDraft,
} from '../coordinates'

const draft = (over: Partial<CoordinateDraft> = {}): CoordinateDraft => ({
  layer: 'user',
  entity: null,
  position: '',
  identifier: 'deploy_steps',
  ...over,
})

describe('坐标的拆分与拼接', () => {
  it('开头就是归属，人格与应用的开头带着它们的标识', () => {
    expect(parseCoordinate('user://projects/kioku/deploy_steps')).toEqual({
      layer: 'user',
      entity: null,
      position: ['projects', 'kioku'],
      identifier: 'deploy_steps',
    })
    expect(parseCoordinate('persona://doubao/soul')).toEqual({
      layer: 'persona',
      entity: 'doubao',
      position: [],
      identifier: 'soul',
    })
    expect(layerOfUri('app://claudecode/agent')).toBe('app')
    expect(identifierOf('core://agent')).toBe('agent')
  })

  it('四种开头以外的、只有人格标识的都拆不出来', () => {
    for (const bad of ['notes://a', 'persona://doubao', 'core://', 'user']) {
      expect(parseCoordinate(bad), bad).toBeNull()
    }
    expect(layerOfUri('notes://a')).toBeNull()
  })

  it('拆开再拼回去还是原样', () => {
    for (const uri of ['core://agent', 'user://a/b/c', 'app://cc/agent', 'persona://p/x/soul']) {
      expect(formatCoordinate(parseCoordinate(uri)!)).toBe(uri)
    }
    expect(coordinateHead('persona', 'doubao')).toBe('persona://doubao/')
    expect(coordinateHead('core', null)).toBe('core://')
  })

  it('给人看的名字是标题，没有时用标识', () => {
    expect(memoryTitle({ uri: 'core://agent', title: '工作流约束' })).toBe('工作流约束')
    expect(memoryTitle({ uri: 'core://agent', title: ' ' })).toBe('agent')
    expect(memoryTitle({ uri: 'core://agent' })).toBe('agent')
  })
})

describe('新建与移动的表单', () => {
  it('归属、位置与标识拼成坐标，合乎契约的格式', () => {
    expect(draftUri(draft({ position: 'projects/kioku' }))).toBe(
      'user://projects/kioku/deploy_steps',
    )
    expect(draftUri(draft({ layer: 'persona', entity: 'doubao' }))).toBe(
      'persona://doubao/deploy_steps',
    )
    // 位置前后多余的斜杠和空白不算
    expect(draftUri(draft({ position: ' /projects/ ' }))).toBe('user://projects/deploy_steps')
    expect(URI_PATTERN.test(draftUri(draft({ layer: 'core' }))!)).toBe(true)
  })

  it('人格、应用没选，标识没填时拼不出来', () => {
    expect(draftUri(draft({ layer: 'app' }))).toBeNull()
    expect(draftUri(draft({ identifier: ' ' }))).toBeNull()
  })

  it('还差什么一次说一件，从上往下', () => {
    expect(draftProblem(draft({ layer: 'persona' }))).toBe('选择人格')
    expect(draftProblem(draft({ layer: 'app' }))).toBe('选择应用')
    expect(draftProblem(draft({ position: 'Projects' }))).toContain('位置的每一级')
    expect(draftProblem(draft({ identifier: '' }))).toBe('填写标识')
    expect(draftProblem(draft({ identifier: '部署' }))).toContain('标识只能用')
    expect(draftProblem(draft())).toBeNull()
  })

  it('最多 16 级，人格或应用的标识也算一级', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `l${i}`).join('/')
    expect(draftProblem(draft({ position: fifteen }))).toBeNull()
    expect(draftProblem(draft({ layer: 'app', entity: 'cc', position: fifteen }))).toContain(
      '最多 16 级',
    )
  })

  it('从英文标题猜标识，中文标题猜不出来', () => {
    expect(identifierFromTitle('Deploy Steps')).toBe('deploy_steps')
    expect(identifierFromTitle('  release-notes draft ')).toBe('release-notes_draft')
    expect(identifierFromTitle('部署步骤')).toBe('')
  })

  it('从目录里选中的那一行带出归属与位置：记忆本身成为位置', () => {
    expect(draftFromKey('')).toEqual({})
    expect(draftFromKey('app')).toEqual({ layer: 'app' })
    expect(draftFromKey('persona://doubao')).toEqual({
      layer: 'persona',
      entity: 'doubao',
      position: '',
    })
    expect(draftFromKey('user://projects/kioku')).toEqual({
      layer: 'user',
      position: 'projects/kioku',
    })
    expect(draftFromKey('app://cc/notes')).toEqual({
      layer: 'app',
      entity: 'cc',
      position: 'notes',
    })
    expect(draftFromKey('subject')).toEqual({})
  })

  it('移动时从现在的坐标改起', () => {
    expect(draftFromUri('app://cc/notes/commit_style')).toEqual({
      layer: 'app',
      entity: 'cc',
      position: 'notes',
      identifier: 'commit_style',
    })
  })

  it('本人默认私密，不设公开', () => {
    expect(DEFAULT_SENSITIVITY.user).toBe('private')
    expect(DEFAULT_SENSITIVITY.app).toBe('internal')
  })
})
