import ui from '@nuxt/ui/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// 开发时把 /v1 转给本机后端；生产环境由后端直接托管构建产物，同源访问
export default defineConfig({
  plugins: [vue(), ui()],
  server: {
    proxy: {
      '/v1': 'http://localhost:18920',
    },
  },
})
