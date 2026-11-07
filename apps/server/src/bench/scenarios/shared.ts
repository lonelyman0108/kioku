import type { BenchRequires } from '@kioku/contracts'

// 内置预设的约定：
// - 只写本人（user://）、不用 priority 0：真实模式下断开时残留的记忆不会进别的应用与启动加载；
// - 写记忆都带 valid_to（${expires}）：残留的记忆几小时后自己过期，不会一直被本人的真实会话召回；
// - 坐标与凭据标识带 ${run}，免得真实模式下撞上上一次；
// - 平台账号用固定值：联系人没有删除接口，带 ${run} 的话每跑一次多两个永久的假联系人；
// - 对 secret 与凭据只断言报错与否和元数据，不断言值：进程内不给值，命令行是真实调用，同一份场景要在两边都过。

// 能读写本人，最高到 private：默认的 agent Key 就是这样
export const USER_WRITE: BenchRequires = {
  readLayers: ['user'],
  writeLayers: ['user'],
  maxSensitivity: 'private',
}

// 再加 secret 级：写 secret 记忆
export const SECRET_WRITE: BenchRequires = { ...USER_WRITE, maxSensitivity: 'secret' }

// 凭据能力为管理：新建、修改、删除凭据（取用与列出也就都能做）
export const CREDENTIAL_MANAGE: BenchRequires = { ...USER_WRITE, credentials: 'manage' }

// 使用指引的开头，普通宿主与群聊 bot 的指引都有
export const GUIDANCE_START = 'Kioku 是你的长期记忆'

// 固定的平台账号：一个测试用的群与群里的一个人
export const BENCH_GROUP_CONTEXT = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'bench-group', name: '测试台的群' },
  sender: { id: 'bench-user', name: '测试台的群友' },
} as const

// 本次运行写下的记忆的坐标：放在本人的 bench 位置下
export const runUri = (name: string) => `user://bench/\${run}/${name}`

// 写记忆的步骤的 valid_to
export const EXPIRES = '${expires}'
