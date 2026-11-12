import { COMMIT_SHA, versionLabel, type UpdateCheckView } from '@kioku/contracts'

// 设置 › 实例 › 系统信息里只有页面用的说法；和诊断信息共用的说法在 contracts 的 system.ts

const REPO_URL = 'https://github.com/lonelyman0108/kioku'

// 提交的短 id 与它在 GitHub 上的页面；没有提交（dev 构建）时都为 null
export const shortCommit = (sha: string | null) => (sha ? sha.slice(0, 7) : null)
export const commitUrl = (sha: string | null) =>
  sha && COMMIT_SHA.test(sha) ? `${REPO_URL}/commit/${sha}` : null

// 检查新版本那一行的状态
export function updateStatus(updates: UpdateCheckView): string {
  if (!updates.enabled) return '已关闭'
  if (!updates.applicable) return '当前不是正式版，不检查'
  if (updates.checking) return '检查中'
  if (updates.available) return `有新版本 ${versionLabel(updates.available.version)}`
  if (updates.failed) return '上次检查失败'
  if (!updates.checkedAt) return '尚未检查'
  return updates.latest ? '已是最新' : '暂无正式版'
}
