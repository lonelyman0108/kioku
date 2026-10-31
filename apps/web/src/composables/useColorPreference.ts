import { useColorMode } from '@nuxt/ui/runtime/vue/stubs/base.js'

import { icons } from '../icons'

export type ColorPreference = 'system' | 'light' | 'dark'

// 主题的三个选项。偏好由 Nuxt UI 的 color mode 记住，这里不另存一份；默认跟随系统
export const COLOR_PREFERENCES: { value: ColorPreference; label: string; icon: string }[] = [
  { value: 'system', label: '跟随系统', icon: icons.themeSystem },
  { value: 'light', label: '浅色', icon: icons.themeLight },
  { value: 'dark', label: '深色', icon: icons.themeDark },
]

export function useColorPreference() {
  const mode = useColorMode()
  return {
    current: () => mode.preference ?? 'system',
    set: (value: ColorPreference) => {
      mode.preference = value
    },
  }
}
