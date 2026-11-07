import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_PLACEHOLDER_START,
  findPlaintextCredentials,
  PLAINTEXT_CREDENTIAL,
  PLAINTEXT_MASK,
  PLAINTEXT_QUOTES,
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

// 把像明文凭据的片段打码：和 looksLikePlaintextCredential 同一条规则，按 findPlaintextCredentials 认出的每一处
// （连同和前一处重叠的），从值开始盖到值所在的最后一行的行尾（「密码：…」的值到哪里结束是猜的，口令短语里有空格；
// 令牌后面紧跟的文字也可能是另一处凭据），私钥块这类跨行的值整段盖掉。值外面的引号与粗体一起盖。
// 挨着的几段合成一段星号。规则会漏，认不出的照原样留下。
// 提示语最长两万字，在主线程上打码：行尾按预先找好的换行位置二分查，区间按先后合并，整段是线性的
const LINE_BREAK = /[\n\r\u2028\u2029]/g
// 值外面的符号最长三个字（***）
const WRAPPER_MAX = 3

export function maskPlaintextCredentials(text: string): string {
  const breaks = [...text.matchAll(LINE_BREAK)].map((m) => m.index)
  // from 所在的行在哪里结束：第一个不早于 from 的换行，没有就是正文的结尾
  const lineEnd = (from: number) => {
    let lo = 0
    let hi = breaks.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (breaks[mid]! < from) lo = mid + 1
      else hi = mid
    }
    return lo < breaks.length ? breaks[lo]! : text.length
  }
  let out = ''
  let last = 0
  // findPlaintextCredentials 按开头的先后给出，往前扩的只有几个引号，合并时按开头比就够了
  for (const m of findPlaintextCredentials(text, { overlapping: true })) {
    let start = m.start
    for (
      let i = 0;
      i < WRAPPER_MAX && start > 0 && PLAINTEXT_QUOTES.includes(text[start - 1]!);
      i++
    ) {
      start--
    }
    const end = Math.max(lineEnd(m.end), m.end)
    if (end <= last) continue
    // 紧接着上一段（或者和它重叠）的不再另起一段星号
    out += start <= last && last > 0 ? '' : `${text.slice(last, start)}${PLAINTEXT_MASK}`
    last = end
  }
  return out + text.slice(last)
}
