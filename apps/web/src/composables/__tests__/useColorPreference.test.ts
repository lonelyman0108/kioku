import { describe, expect, it } from 'vitest'

import { COLOR_PREFERENCES, useColorPreference } from '../useColorPreference'

// #imports 不是 Nuxt UI 写在文档里的接口，升级时它改了或不再给 useColorMode，这里先报错
describe('主题偏好', () => {
  it('默认跟随系统，三个选项都能设上、读回来', () => {
    const preference = useColorPreference()
    expect(preference.current()).toBe('system')
    for (const { value } of COLOR_PREFERENCES) {
      preference.set(value)
      expect(preference.current()).toBe(value)
    }
    preference.set('system')
  })
})
