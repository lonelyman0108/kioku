import type { BenchRequires } from '@kioku/contracts'

// 内置预设的约定：
// - 不用 priority 0：真实模式下断开时残留的词条不会进启动加载与别的应用；
// - 写词条都带 valid_to（${expires}）：残留的词条几小时后自己过期，不会一直被本人的真实会话召回；
// - 标题、关键词与凭据标识带 ${run}，免得真实模式下撞上上一次；
// - 平台账号、deviceKey 与 project 用固定值：联系人与自动登记的词表项没有删除接口，带 ${run} 会逐次累积假记录；
// - 对 secret 与凭据只断言报错与否和元数据，不断言值：进程内不给值，命令行是真实调用，同一份场景要在两边都过

// 能读写正式词条，最高到 private：默认接入密钥常用配置
export const ENTRY_WRITE: BenchRequires = {
  readKinds: ['entry'],
  writeKinds: ['entry'],
  maxSensitivity: 'private',
}

// 能读写公开正式词条
export const PUBLIC_WRITE: BenchRequires = {
  readKinds: ['entry'],
  writeKinds: ['entry'],
  maxSensitivity: 'public',
}

// 再加 secret 级：写 secret 词条
export const SECRET_WRITE: BenchRequires = { ...ENTRY_WRITE, maxSensitivity: 'secret' }

// 凭据能力为管理：新建、修改、删除凭据
export const CREDENTIAL_MANAGE: BenchRequires = { ...ENTRY_WRITE, credentials: 'manage' }

// 仅个人圈允许在词条正文里引用 {{cred:...}} 占位符
export const PERSONAL_CREDENTIAL_REF: BenchRequires = {
  ...CREDENTIAL_MANAGE,
  circleKind: 'personal',
}

// 使用指引的开头，普通宿主与群聊 bot 的指引都有
export const GUIDANCE_START = 'Kioku 是你的长期记忆'

// 固定的平台账号：测试用的两个群与群友（不带 ${run}）
export const BENCH_GROUP_CONTEXT = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'bench-group', name: '测试台的群' },
  sender: { id: 'bench-user', name: '测试台的群友' },
} as const

export const BENCH_GROUP_2_CONTEXT = {
  chatType: 'group',
  platform: 'bench',
  group: { id: 'bench-group-2', name: '测试台的二群' },
  sender: { id: 'bench-user', name: '测试台的群友' },
} as const

// 固定的终端与项目上下文（不带 ${run}，避免逐次登记新的自动 project 词表项）
export const BENCH_DEVICE_KEY = 'bench-device'
export const BENCH_PROJECT = { dirName: 'kioku-bench' } as const

// 带运行标记的标题，供精确标题引用与清理
export const runTitle = (name: string) => `${name}-\${run}`

// 写词条的步骤的 valid_to
export const EXPIRES = '${expires}'
