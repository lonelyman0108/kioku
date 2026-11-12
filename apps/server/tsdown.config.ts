import { fileURLToPath } from 'node:url'

import { defineConfig } from 'tsdown'

import { readGit, resolveBuildInfo } from './src/buildInfo.ts'

// 版本、提交、构建时间在打包时写进产物（见 src/version.ts）：镜像构建时取 Dockerfile 传入的构建参数，本地取 git。
// buildInfo 引用 contracts 的源码（导入不带扩展名），原生的配置加载器解析不了，所以 build 脚本用 tsx 加载本配置
const build = resolveBuildInfo(process.env, () =>
  readGit(fileURLToPath(new URL('.', import.meta.url))),
)

// workspace 内的包是 TS 源码，打进产物里；npm 依赖保持外部引用。
// 除服务入口外还打包命令行工具：dist/import-lore.mjs、dist/backup.mjs、dist/restore.mjs、dist/bench.mjs
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'import-lore': 'src/cli/importLore.ts',
    backup: 'src/cli/backup.ts',
    restore: 'src/cli/restore.ts',
    bench: 'src/cli/bench.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@kioku\//],
  define: { __KIOKU_BUILD__: JSON.stringify(build) },
})
