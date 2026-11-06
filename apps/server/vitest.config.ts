import { defineConfig } from 'vitest/config'

import { testWorkers } from './src/testing/workers'

// 集成测试会清空整个库，同一个库上的测试文件必须串行；
// 设了 KIOKU_TEST_DATABASE_WORKERS 时每个 worker 有自己的库，按这个数并行
const workers = testWorkers()
export default defineConfig({
  test: {
    fileParallelism: workers > 1,
    maxWorkers: workers,
  },
})
