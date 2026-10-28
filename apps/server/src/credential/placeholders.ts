import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_PLACEHOLDER_START,
  PLAINTEXT_CREDENTIAL,
  type Layer,
  type Sensitivity,
} from '@kioku/contracts'

import { sensitivityRank } from '../access/access'

export interface PlaceholderRef {
  identifier: string
  // 引用整条凭据时为 null
  field: string | null
}

// 找出正文里的占位符。正文里任何位置的 {{cred: 都算，代码块与行内代码里的也算：agent 读得到全部文字。
// 格式不对的（例如标识里有大写字母、没有结尾的花括号）放进 malformed，写入时拒绝
export function scanPlaceholders(text: string): { refs: PlaceholderRef[]; malformed: string[] } {
  const refs: PlaceholderRef[] = []
  const valid = new Set<number>()
  for (const m of text.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER.source, 'g'))) {
    valid.add(m.index)
    refs.push({ identifier: m[1]!, field: m[2] ?? null })
  }
  const malformed: string[] = []
  for (
    let at = text.indexOf(CREDENTIAL_PLACEHOLDER_START);
    at !== -1;
    at = text.indexOf(CREDENTIAL_PLACEHOLDER_START, at + 1)
  ) {
    if (!valid.has(at)) malformed.push(text.slice(at, at + 48).split('\n')[0]!)
  }
  return { refs, malformed }
}

// 占位符只能放在私人层、敏感级至少 private 的记忆里：按记忆主人解析，别的层的读者解析不到。
// 写入检查与导入计划都按这条判断
export function placeholderAllowed(layer: Layer, sensitivity: Sensitivity): boolean {
  return layer === 'private' && sensitivityRank(sensitivity) >= sensitivityRank('private')
}

// disclosure 与关键词里不能有占位符（会进召回与 boot 的线索）：写入与导入计划都按这条判断
export function mentionsPlaceholder(text: string): boolean {
  return text.includes(CREDENTIAL_PLACEHOLDER_START)
}

export function placeholderIdentifiers(text: string): Set<string> {
  return new Set(scanPlaceholders(text).refs.map((r) => r.identifier))
}

export function looksLikePlaintextCredential(text: string): boolean {
  return PLAINTEXT_CREDENTIAL.test(text)
}

// 把像明文凭据的片段打码：和 looksLikePlaintextCredential 同一条规则。「密码：…」这类写法从值开始盖到行尾
// （值里可能有空格，例如口令短语）；sk- 开头的串盖到下一个空白。挨着的几处凭据各自打码，
// 前一处盖住的范围里开始的匹配接着往后盖，不会因为重叠漏掉。规则会漏，认不出的照原样留下
const PLAINTEXT_ALL = new RegExp(PLAINTEXT_CREDENTIAL.source, 'gi')
export function maskPlaintextCredentials(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(PLAINTEXT_ALL)) {
    const token = /^sk-/i.test(m[0])
    // 「密码：x」这类只匹配到值的第一个字，sk- 开头的整串都是值
    const valueAt = Math.max(last, m.index + (token ? 0 : m[0].length - 1))
    let end = Math.max(last, m.index + m[0].length)
    const stop = token ? /\s/ : /[\n\r\u2028\u2029]/
    while (end < text.length && !stop.test(text[end]!)) end++
    if (end <= last) continue
    out += `${text.slice(last, valueAt)}***`
    last = end
  }
  return out + text.slice(last)
}
