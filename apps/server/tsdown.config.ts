import { defineConfig } from 'tsdown'

// workspace 内的包是 TS 源码，打进产物里；npm 依赖保持外部引用。
// 除服务入口外还打包命令行工具：dist/import-lore.mjs
export default defineConfig({
  entry: { index: 'src/index.ts', 'import-lore': 'src/cli/importLore.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@kioku\//],
})
