import { z } from 'zod'

// zod 默认会用 new Function 试探能不能编译加速代码；管理界面的 CSP 不允许 eval，
// 试探会在控制台报一条违规。关掉这项优化，校验照常工作
z.config({ jitless: true })
