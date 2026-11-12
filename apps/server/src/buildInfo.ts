import { execFileSync } from 'node:child_process'

// 构建信息：版本、提交、构建时间。打包时由 tsdown.config.ts 算好写进产物（见 version.ts），运行时的环境变量改不了它们
export interface BuildInfo {
  version: string
  // 完整的提交 sha；不知道时为 null
  commit: string | null
  // ISO 时间；不知道时为 null
  builtAt: string | null
}

export interface GitInfo {
  describe: string
  sha: string
}

// 版本里只收这些字符：它会进响应、诊断信息与 MCP 的握手
const VERSION_TEXT = /^[\w.+-]{1,64}$/
const COMMIT = /^[0-9a-f]{7,40}$/i

const versionOf = (value: string | undefined) => {
  const text = value?.trim()
  return text && VERSION_TEXT.test(text) ? text : null
}
const commitOf = (value: string | undefined) => {
  const text = value?.trim()
  return text && COMMIT.test(text) ? text.toLowerCase() : null
}
const timeOf = (value: string | undefined) => {
  const time = value?.trim() ? new Date(value.trim()) : null
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : null
}

// 构建参数（KIOKU_VERSION、KIOKU_COMMIT、KIOKU_BUILD_TIME，镜像构建时由 Dockerfile 传入）给了任何一个时以它们为准：
// 镜像的构建上下文里没有 .git。都没给时取 git：版本是 git describe 的结果（没有 tag 时是短 id，有未提交的改动带 -dirty），
// 提交是完整的 sha。都取不到时版本是 dev。构建时间没给时取现在
export function resolveBuildInfo(
  env: Record<string, string | undefined>,
  git: () => GitInfo | null,
  now: Date = new Date(),
): BuildInfo {
  const given = ['KIOKU_VERSION', 'KIOKU_COMMIT', 'KIOKU_BUILD_TIME'].some((name) =>
    env[name]?.trim(),
  )
  const builtAt = timeOf(env.KIOKU_BUILD_TIME) ?? now.toISOString()
  if (given) {
    return {
      version: versionOf(env.KIOKU_VERSION) ?? 'dev',
      commit: commitOf(env.KIOKU_COMMIT),
      builtAt,
    }
  }
  const info = git()
  return {
    version: versionOf(info?.describe) ?? 'dev',
    commit: commitOf(info?.sha),
    builtAt,
  }
}

// 在 cwd 所在的仓库里取 git 信息；没装 git、不在仓库里时为 null
export function readGit(cwd: string): GitInfo | null {
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim()
  try {
    return {
      describe: run(['describe', '--tags', '--always', '--dirty']),
      sha: run(['rev-parse', 'HEAD']),
    }
  } catch {
    return null
  }
}
