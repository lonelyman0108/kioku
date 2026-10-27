import { fileURLToPath } from 'node:url'

import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import { icons } from './src/icons.ts'

// 开发时把 /v1 转给本机后端；生产环境由后端直接托管构建产物，同源访问
export default defineConfig({
  plugins: [
    vue(),
    ui({
      // 界面用到的图标全部打进产物，运行时不向 Iconify 公共接口请求
      icon: { clientBundle: { icons: Object.values(icons) } },
    }),
  ],
  resolve: {
    // 所有 import 'zod'（包括 contracts 里的）都换成 src/zod.ts：它先关掉 zod 的 eval 试探再交出 zod。
    // 只在入口最先导入它不够：打包后 zod 与 contracts 落在入口要先加载的共享分块里，会比入口里的设置先执行
    alias: [
      { find: /^zod$/, replacement: fileURLToPath(new URL('./src/zod.ts', import.meta.url)) },
    ],
  },
  server: {
    proxy: {
      '/v1': 'http://localhost:18920',
    },
  },
})
