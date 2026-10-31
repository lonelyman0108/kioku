import {
  CREDENTIAL_PLACEHOLDER,
  findPlaintextCredentials,
  type ConvertedToCredential,
} from '@kioku/contracts'

// 转存为凭据的对话框：猜出来的值、建议的标识、值在正文里的位置和次数

// 占位符放不进这条记忆时的说明：列表、详情和对话框共用
export const CONVERT_SCOPE_TEXT =
  '凭据占位符只能放在私人层、敏感级不低于私密的记忆中。请先调整这条记忆的层与敏感级，再转存。'

// 疑似明文的一处。值的结尾是规则猜的，要让人看过再提交
export interface PlaintextCandidate {
  value: string
  field: string
}

export function plaintextCandidates(content: string): PlaintextCandidate[] {
  const seen = new Set<string>()
  return findPlaintextCredentials(content).flatMap((match) => {
    const value = content.slice(match.start, match.end)
    if (seen.has(value)) return []
    seen.add(value)
    return [{ value, field: match.field }]
  })
}

const IDENTIFIER_MAX = 64

// 按 URI 建议一个标识：路径的各段连起来，比如 infra://nas/admin 是 nas-admin。URI 的段已经只有小写字母、
// 数字、_ 和 -，开头是 _ 或 - 时去掉。已经有这个标识的凭据时加上字段名，再不行加序号
export function suggestIdentifier(uri: string, field: string, taken: readonly string[]): string {
  const path = uri.split('://')[1] ?? ''
  const base =
    path
      .replaceAll('/', '-')
      .replace(/^[-_]+/, '')
      .slice(0, IDENTIFIER_MAX)
      .replace(/[-_]+$/, '') || field
  const used = new Set(taken)
  const fit = (suffix: string) => `${base.slice(0, IDENTIFIER_MAX - suffix.length)}${suffix}`
  if (!used.has(base)) return base
  if (!used.has(fit(`-${field}`))) return fit(`-${field}`)
  for (let n = 2; ; n++) {
    if (!used.has(fit(`-${n}`))) return fit(`-${n}`)
  }
}

// 建议的名称：路径本身，比 URI 少了 domain，人读起来够了
export const suggestName = (uri: string) => uri.split('://')[1] ?? uri

// 正文里跳过占位符之后的几段：值恰好是占位符里的标识时不算，和服务端替换时一个规则
function outsidePlaceholders(content: string): { text: string; start: number }[] {
  const parts: { text: string; start: number }[] = []
  let last = 0
  for (const m of content.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER.source, 'g'))) {
    parts.push({ text: content.slice(last, m.index), start: last })
    last = m.index + m[0].length
  }
  parts.push({ text: content.slice(last), start: last })
  return parts
}

// 这个值在正文里出现几处，都会被换掉
export function occurrences(content: string, value: string): number {
  if (!value) return 0
  return outsidePlaceholders(content).reduce(
    (sum, part) => sum + part.text.split(value).length - 1,
    0,
  )
}

export interface ValueContext {
  before: string
  after: string
  clippedBefore: boolean
  clippedAfter: boolean
}

const CONTEXT_CHARS = 32
const LINE_BREAK = /[\n\r\u2028\u2029]/

// 第一处的前后文，用来核对值的结尾猜得对不对。只取同一行，按字符截断（不切开表情符号）
export function valueContext(content: string, value: string): ValueContext | null {
  if (!value) return null
  for (const part of outsidePlaceholders(content)) {
    const at = part.text.indexOf(value)
    if (at < 0) continue
    const start = part.start + at
    const before = [...content.slice(0, start).split(LINE_BREAK).pop()!]
    const after = [...content.slice(start + value.length).split(LINE_BREAK)[0]!]
    return {
      before: before.slice(-CONTEXT_CHARS).join(''),
      after: after.slice(0, CONTEXT_CHARS).join(''),
      clippedBefore: before.length > CONTEXT_CHARS,
      clippedAfter: after.length > CONTEXT_CHARS,
    }
  }
  return null
}

// 转存做了什么：一整句，模板里中文换行会多出空格
export function convertSummary(result: ConvertedToCredential): string {
  const done = `已新建凭据「${result.credential.name}」，正文中 ${result.replaced} 处已换成占位符。`
  return result.scrubbedEvents
    ? `${done}历史中 ${result.scrubbedEvents} 个事件里的这个值也已替换。`
    : done
}

// 转存之后还要告诉人的：只换了选定的这一个值。没有遗留时是空的
export interface ConvertLeftover {
  title: string
  detail: string
}

export function convertLeftovers(result: ConvertedToCredential): ConvertLeftover[] {
  const leftovers: ConvertLeftover[] = []
  if (result.plaintextVersions > 0) {
    leftovers.push({
      title: `历史中还有 ${result.plaintextVersions} 个版本疑似含其他明文`,
      detail:
        '例如更换前的旧密码，这次只处理了选定的值。如需全部抹除，可将这条记忆改为机密；仍在使用的值建议更换。',
    })
  }
  if (result.otherMemories > 0) {
    leftovers.push({
      title: `其他记忆中还有 ${result.otherMemories} 条含这个值`,
      detail: '这些记忆未改动（已删除、已过期的也计算在内），可逐条转存或修改。',
    })
  }
  return leftovers
}
