import { fileURLToPath } from 'node:url'

import { readGit, resolveBuildInfo, type BuildInfo } from './buildInfo'

// 打包时由 tsdown.config.ts 的 define 换成构建信息的字面量
declare const __KIOKU_BUILD__: BuildInfo | undefined

// 产物里是打包时写进去的构建信息。不经打包直接跑源码时（pnpm dev、测试）现取 git，同样不读运行时的环境变量
export const BUILD: BuildInfo =
  typeof __KIOKU_BUILD__ === 'undefined'
    ? resolveBuildInfo({}, () => readGit(fileURLToPath(new URL('.', import.meta.url))))
    : __KIOKU_BUILD__

export const VERSION = BUILD.version
