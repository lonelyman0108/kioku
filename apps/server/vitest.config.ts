import { defineConfig } from 'vitest/config'

// 集成测试共用一个数据库并会清空数据，测试文件之间必须串行
export default defineConfig({
  test: {
    fileParallelism: false,
  },
})
