import { styleText } from 'node:util'

// 终端样式与等宽排版：非终端或设置 NO_COLOR 时退回纯文本，不输出 ANSI 转义序列

export interface OutputStream {
  isTTY?: boolean
  columns?: number
  write: (chunk: string) => unknown
}

const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(0x1b)}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${String.fromCharCode(0x07)}${String.fromCharCode(0x1b)}]*(?:${String.fromCharCode(0x07)}|${String.fromCharCode(0x1b)}\\\\))`,
  'g',
)

const ZERO_WIDTH = /^(?:\p{Mn}|\p{Me}|\p{Cf}|\u200d|\ufe0e|\ufe0f)$/u

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '')
}

// 东亚全角、宽字符与常见 emoji 按 2 列算；制表框线与状态符号按 1 列算
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e && code !== 0x303f) ||
    (code >= 0x3040 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text)
  let width = 0
  for (const ch of plain) {
    if (ZERO_WIDTH.test(ch)) continue
    const code = ch.codePointAt(0)
    if (code === undefined) continue
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

export function padDisplay(text: string, width: number): string {
  const diff = width - displayWidth(text)
  return diff > 0 ? `${text}${' '.repeat(diff)}` : text
}

export function supportsColor(
  stream: Pick<OutputStream, 'isTTY'> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false
  if (env.TERM === 'dumb') return false
  return stream.isTTY === true
}

type TextStyle = 'bold' | 'dim' | 'green' | 'yellow' | 'red'

function styled(
  format: TextStyle,
  text: string,
  stream: Pick<OutputStream, 'isTTY'> = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!text || !supportsColor(stream, env)) return text
  return styleText(format, text, { validateStream: false })
}

export const bold = (text: string, stream?: Pick<OutputStream, 'isTTY'>, env?: NodeJS.ProcessEnv) =>
  styled('bold', text, stream, env)

export const dim = (text: string, stream?: Pick<OutputStream, 'isTTY'>, env?: NodeJS.ProcessEnv) =>
  styled('dim', text, stream, env)

export const green = (
  text: string,
  stream?: Pick<OutputStream, 'isTTY'>,
  env?: NodeJS.ProcessEnv,
) => styled('green', text, stream, env)

export const yellow = (
  text: string,
  stream?: Pick<OutputStream, 'isTTY'>,
  env?: NodeJS.ProcessEnv,
) => styled('yellow', text, stream, env)

export const red = (text: string, stream?: Pick<OutputStream, 'isTTY'>, env?: NodeJS.ProcessEnv) =>
  styled('red', text, stream, env)

export interface FormatRowsOptions {
  stream?: Pick<OutputStream, 'isTTY'>
  env?: NodeJS.ProcessEnv
  gap?: number
}

export function formatRows(
  rows: readonly [label: string, value: string][],
  options: FormatRowsOptions = {},
): string[] {
  const gap = options.gap ?? 2
  const labelWidth = Math.max(0, ...rows.map(([label]) => displayWidth(label)))
  return rows.map(([label, value]) => {
    const padded = padDisplay(label, labelWidth)
    const left = dim(padded, options.stream, options.env)
    return `${left}${' '.repeat(gap)}${value}`
  })
}

export type StrataLine = string | { divider: true }

export interface StrataBoxOptions {
  stream?: Pick<OutputStream, 'isTTY' | 'columns'>
  env?: NodeJS.ProcessEnv
  width?: number
  badge?: string
}

// 地层风直角细线框：┌ ─ ┐ │ └ ─ ┘
export function renderStrataBox(
  title: string,
  lines: readonly StrataLine[],
  options: StrataBoxOptions = {},
): string {
  const { stream, env } = options
  const badgeSuffix = options.badge ? ` ${options.badge} ─` : ''
  const titleWidth = displayWidth(title)
  const badgeWidth = displayWidth(badgeSuffix)
  const contentWidth = Math.max(
    0,
    ...lines.map((line) => (typeof line === 'string' ? displayWidth(line) : 0)),
  )
  const minHeader = titleWidth + badgeWidth + 3
  const inner = Math.max(options.width ?? 0, minHeader, contentWidth)

  const dashCount = Math.max(1, inner - titleWidth - badgeWidth - 1)
  const topLeft = dim('┌─ ', stream, env)
  const topTitle = bold(title, stream, env)
  const topDashes = dim(` ${'─'.repeat(dashCount)}`, stream, env)
  const topBadge = options.badge
    ? `${dim(' ', stream, env)}${dim(options.badge, stream, env)}${dim(' ─', stream, env)}`
    : ''
  const topRight = dim('┐', stream, env)
  const top = `${topLeft}${topTitle}${topDashes}${topBadge}${topRight}`

  const side = dim('│', stream, env)
  const divider = dim(`├${'─'.repeat(inner + 2)}┤`, stream, env)
  const bottom = dim(`└${'─'.repeat(inner + 2)}┘`, stream, env)

  const body = lines.map((line) =>
    typeof line === 'string' ? `${side} ${padDisplay(line, inner)} ${side}` : divider,
  )
  return [top, ...body, bottom].join('\n')
}
