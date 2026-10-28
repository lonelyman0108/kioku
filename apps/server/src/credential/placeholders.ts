import {
  CREDENTIAL_PLACEHOLDER,
  CREDENTIAL_PLACEHOLDER_START,
  PLAINTEXT_CREDENTIAL,
} from '@kioku/contracts'

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

export function looksLikePlaintextCredential(text: string): boolean {
  return PLAINTEXT_CREDENTIAL.test(text)
}
