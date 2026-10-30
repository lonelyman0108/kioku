import type { BenchRequires } from '@kioku/contracts'

// 内置预设的约定：
// - 只写私人层、不用 priority 0：真实模式下断开时残留的记忆不会进别的应用与启动上下文；
// - URI 与凭据标识带 ${run}，免得真实模式下撞上上一次；
// - 平台账号用固定值：对象没有删除接口，带 ${run} 的话每跑一次多两个永久的假对象；
// - 对 secret 与凭据只断言报错与否和元数据，不断言值：进程内打码，命令行不打码，同一份场景要在两边都过。

// 能读写私人层，最高到 private：默认的 agent Key 就是这样
export const PRIVATE_WRITE: BenchRequires = {
  readLayers: ['private'],
  writeLayers: ['private'],
  maxSensitivity: 'private',
}

// 再加 secret 级：管理凭据、写 secret 记忆
export const SECRET_WRITE: BenchRequires = { ...PRIVATE_WRITE, maxSensitivity: 'secret' }

// 使用指引的开头，普通宿主与群聊 bot 的指引都有
export const GUIDANCE_START = 'Kioku 是你的长期记忆'

// 固定的平台账号：一个测试用的群与群里的一个人
export const BENCH_GROUP_CONTEXT = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'bench-group', name: '测试台的群' },
  sender: { id: 'bench-user', name: '测试台的群友' },
} as const

// 本次运行写下的记忆的路径
export const runUri = (name: string) => `projects://bench/\${run}/${name}`
