// 界面里用到的全部图标。vite.config.ts 用这份清单把图标打进构建产物：
// 没列进来的图标会在运行时向公共 Iconify 接口请求，自托管服务不应该向第三方发请求
export const icons = {
  memories: 'i-lucide-brain',
  personas: 'i-lucide-drama',
  apps: 'i-lucide-key-round',
  settings: 'i-lucide-settings',
  logout: 'i-lucide-log-out',
  add: 'i-lucide-plus',
  save: 'i-lucide-save',
  remove: 'i-lucide-trash-2',
  move: 'i-lucide-folder-input',
  copy: 'i-lucide-copy',
  refresh: 'i-lucide-refresh-cw',
  folder: 'i-lucide-folder',
  file: 'i-lucide-file-text',
  secret: 'i-lucide-lock',
  test: 'i-lucide-plug-zap',
} as const
