import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import { icons } from './src/icons'

// 开发时把 /v1 转给本机后端；生产环境由后端直接托管构建产物，同源访问
export default defineConfig({
  plugins: [
    vue(),
    ui({
      // 界面用到的图标全部打进产物，运行时不向 Iconify 公共接口请求
      icon: { clientBundle: { icons: Object.values(icons) } },
    }),
  ],
  server: {
    proxy: {
      '/v1': 'http://localhost:18920',
    },
  },
})
