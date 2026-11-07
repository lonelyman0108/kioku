import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_PLACEHOLDER_START,
  findPlaintextCredentials,
  PLAINTEXT_CREDENTIAL,
  PLAINTEXT_MASK,
} from '@kioku/contracts'

export { placeholderAllowed } from '@kioku/contracts'

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

// disclosure 与关键词里不能有占位符（会进召回与 boot 的线索）：写入与导入计划都按这条判断
export function mentionsPlaceholder(text: string): boolean {
  return text.includes(CREDENTIAL_PLACEHOLDER_START)
}

export function placeholderIdentifiers(text: string): Set<string> {
  return new Set(scanPlaceholders(text).refs.map((r) => r.identifier))
}

// 把文字里的一个值换掉，跳过格式正确的占位符：值可能恰好是 cred，或者就是占位符里的标识，换了就把引用改坏了。
// 格式不对的不算占位符，里面的值照样换。返回换完的文字与换了几处
export function replaceOutsidePlaceholders(
  text: string,
  value: string,
  replacement: string,
): { text: string; replaced: number } {
  let replaced = 0
  const swap = (part: string) => {
    const pieces = part.split(value)
    replaced += pieces.length - 1
    return pieces.join(replacement)
  }
  let out = ''
  let last = 0
  for (const m of text.matchAll(new RegExp(CREDENTIAL_PLACEHOLDER.source, 'g'))) {
    out += swap(text.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return { text: out + swap(text.slice(last)), replaced }
}

export function looksLikePlaintextCredential(text: string): boolean {
  return PLAINTEXT_CREDENTIAL.test(text)
}

// 把像明文凭据的片段打码：和 looksLikePlaintextCredential 同一条规则，按 findPlaintextCredentials 认出的每一处，
// 从值开始盖到值所在的最后一行的行尾（「密码：…」的值到哪里结束是猜的，口令短语里有空格；令牌后面紧跟的文字
// 也可能是另一处凭据），私钥块这类跨行的值整段盖掉。值外面的引号与粗体一起盖。
// findPlaintextCredentials 不报的匹配（值里带着占位符这类）从匹配的开头盖到行尾，盖过之后规则不再算明文。
// 挨着的几段合成一段星号。规则会漏，认不出的照原样留下
const PLAINTEXT_ALL = new RegExp(PLAINTEXT_CREDENTIAL.source, 'gi')
const VALUE_WRAPPERS = '"\'`“‘「『*'
const LINE_BREAK = /[\n\r\u2028\u2029]/

export function maskPlaintextCredentials(text: string): string {
  const lineEnd = (from: number) => {
    let end = from
    while (end < text.length && !LINE_BREAK.test(text[end]!)) end++
    return end
  }
  const ranges: [number, number][] = []
  for (const m of findPlaintextCredentials(text)) {
    let start = m.start
    while (start > 0 && VALUE_WRAPPERS.includes(text[start - 1]!)) start--
    ranges.push([start, Math.max(lineEnd(m.end), m.end)])
  }
  const covered = (i: number) => ranges.some(([start, end]) => start <= i && i < end)
  for (const m of text.matchAll(PLAINTEXT_ALL)) {
    // 「密码：x」这类匹配到值的第一个字为止，令牌整串都在匹配里：最后一个字没盖住就是漏了的，
    // 从匹配的开头盖起（开头已经盖住时从最后一个字）
    const tail = m.index + m[0].length - 1
    if (covered(tail)) continue
    const start = covered(m.index) ? tail : m.index
    ranges.push([start, lineEnd(tail)])
  }
  ranges.sort((x, y) => x[0] - y[0])
  let out = ''
  let last = 0
  for (const [start, end] of ranges) {
    if (end <= last) continue
    // 紧接着上一段（或者和它重叠）的不再另起一段星号
    out += start <= last && last > 0 ? '' : `${text.slice(last, start)}${PLAINTEXT_MASK}`
    last = end
  }
  return out + text.slice(last)
}
