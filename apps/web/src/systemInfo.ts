import type { ConfigInfo, SystemInfo } from '@kioku/contracts'

// 设置 › 实例 › 系统信息的说法和计算

const REPO_URL = 'https://github.com/lonelyman0108/kioku'

// 提交的短 id 与它在 GitHub 上的页面；没有提交（dev 构建）时都为 null
export const shortCommit = (sha: string | null) => (sha ? sha.slice(0, 7) : null)
export const commitUrl = (sha: string | null) =>
  sha && /^[0-9a-f]{7,40}$/.test(sha) ? `${REPO_URL}/commit/${sha}` : null

// 已运行多久：天、小时、分钟，最多两级
export function uptimeText(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days) return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`
  if (hours) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`
  return minutes ? `${minutes} 分钟` : '不到 1 分钟'
}

export const WEB_UI_TEXT: Record<ConfigInfo['webUi'], string> = {
  served: '已托管',
  missing: '未找到构建产物',
  off: '未配置目录',
}

export const configured = (value: boolean) => (value ? '已配置' : '未配置')

// 账号菜单底部的版本：正式版前面加 v，别的原样
export const versionLabel = (version: string) =>
  /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : version

// 检查新版本那一行的状态
export function updateStatus(updates: SystemInfo['updates']): string {
  if (!updates.enabled) return '已关闭'
  if (!updates.applicable) return '当前不是正式版，不检查'
  if (!updates.checkedAt) return '尚未检查'
  if (updates.available) return `有新版本 ${versionLabel(updates.available.version)}`
  if (updates.failed) return '上次检查失败'
  return updates.latest ? '已是最新' : '暂无正式版'
}
