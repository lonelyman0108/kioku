// Claude Code 钩子：把 SessionStart、UserPromptSubmit 转发给 Kioku 的生命周期端点，
// 服务端返回的输出原样写到标准输出。插件里不放提示词和格式逻辑，都由服务端决定。
// 任何失败都以退出码 0 结束、不写标准输出：记忆服务出问题不能挡住用户的输入。
// 服务地址与 Key 来自插件配置（启用插件时填写），Claude Code 以 CLAUDE_PLUGIN_OPTION_* 环境变量传进来

import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

// 各事件等待服务端的上限（毫秒），要比 hooks.json 里的 timeout 短
const TIMEOUTS = { 'session.start': 8000, 'prompt.submit': 5000 }
// 与服务端 contracts 的上限一致
const MAX_PROMPT = 20_000
const MAX_SESSION_ID = 200
const MAX_NAME = 128

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// 当前项目的目录名与 git 仓库名，服务端用它们召回与项目相关的记忆；取不到的就不带
function projectOf(cwd) {
  const project = {}
  const dirName = basename(cwd)
  if (dirName) project.dirName = dirName.slice(0, MAX_NAME)
  try {
    const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const repoName = /([^/:]+?)(?:\.git)?$/.exec(remote)?.[1]
    if (repoName) project.repoName = repoName.slice(0, MAX_NAME)
  } catch {
    // 不是 git 仓库或没有 origin
  }
  return project
}

// 只把上下文文本交给 Claude Code，钩子输出的其他字段（例如 decision、continue）一律不透传：
// 记忆服务能决定注入什么内容，但不能挡住用户的输入或改变会话
function writeContext(event, text) {
  if (typeof text !== 'string' || !text) return
  if (event === 'session.start') {
    const hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: text }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }))
  } else {
    // UserPromptSubmit 的标准输出纯文本会作为附加上下文
    process.stdout.write(text)
  }
}

function contextOf(hostOutput) {
  if (hostOutput?.mode === 'stdout_json')
    return hostOutput.value?.hookSpecificOutput?.additionalContext
  if (hostOutput?.mode === 'stdout_text') return hostOutput.value
  return undefined
}

async function main(event) {
  const timeout = TIMEOUTS[event]
  if (!timeout) throw new Error(`未知事件 ${event}`)
  const base = (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL ?? '').trim().replace(/\/+$/, '')
  const key = (process.env.CLAUDE_PLUGIN_OPTION_API_KEY ?? '').trim()
  let input = {}
  try {
    input = JSON.parse((await readStdin()) || '{}')
  } catch {
    // 输入不是 JSON 时按空输入处理：会话开始照常注入，提交的提示语为空则不召回
  }

  if (!base || !key) {
    // 只在会话开始时提示一次，让模型告诉用户插件还没配置好
    if (event === 'session.start') {
      writeContext(
        event,
        'Kioku 插件还没有配置服务地址和 API Key，长期记忆不可用：在 /plugin 里为 kioku 填写配置。',
      )
    }
    return
  }

  const body = { event }
  if (typeof input.session_id === 'string' && input.session_id) {
    body.sessionId = input.session_id.slice(0, MAX_SESSION_ID)
  }
  if (event === 'session.start') {
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
    const project = projectOf(cwd)
    if (Object.keys(project).length) body.project = project
  }
  if (event === 'prompt.submit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) return
    body.prompt = prompt.slice(0, MAX_PROMPT)
  }

  const res = await fetch(`${base}/v1/lifecycle/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { hostOutput } = await res.json()
  writeContext(event, contextOf(hostOutput))
}

const event = process.argv[2]
main(event).catch((err) => {
  // 标准错误只出现在 Claude Code 的调试输出里，不进上下文
  process.stderr.write(`Kioku ${event ?? ''} 未生效：${err instanceof Error ? err.message : err}\n`)
})
