import { defineConfig } from 'tsdown'

// workspace 内的包是 TS 源码，打进产物里；npm 依赖保持外部引用
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@kioku\//],
})
