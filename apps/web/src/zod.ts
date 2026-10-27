import { config } from 'zod/v4/core'

// zod 默认会用 new Function 试探能不能编译加速代码；管理界面的 CSP 不允许 eval，
// 试探会在控制台报一条违规。关掉这项优化，校验照常工作。
// 管理界面里所有 import 'zod' 都经过这个模块（见 vite.config.ts 的 alias）：用到 zod 的模块
// 都要等它执行完才执行，所以不管打包后怎么分块，建 schema 之前都已经关掉了
config({ jitless: true })

export * from 'zod/v4'
export { z, default } from 'zod/v4'
