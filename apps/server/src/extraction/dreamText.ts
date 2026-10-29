import {
  looksLikePlaintextCredential,
  mentionsPlaceholder,
  placeholderIdentifiers,
  scanPlaceholders,
} from '../credential/placeholders'
import { MAX_FACT_CHARS } from './extract'

// Dream 的建议里要写进记忆的文字：模型给的（生成建议时，不合规就丢掉这条建议）和执行时的（成员改过的或者原样的，
// 不合规返回 400）过同一套检查。都不能像有明文凭据；合并后的策展记忆只能带合并的几条里本来就有的凭据占位符，
// 事实、提炼的草稿与 disclosure 都不能带占位符（事实里没有凭据引用，提炼不出来）。
// 每个函数返回不合规的原因，合规时返回 null；压成一行、去掉首尾空白由调用方先做

export const MERGED_NODE_CHARS = 6_000
export const DRAFT_CHARS = 2_000
export const DISCLOSURE_CHARS = 200

const PLAINTEXT = '像有明文密码或 Token：Dream 的建议里不写凭据的值'

// 合并后的事实：一句话，长度和抽取的事实一样有上限
export function factProblem(text: string): string | null {
  if (!text || [...text].length > MAX_FACT_CHARS) {
    return `合并后的事实是一句话，不超过 ${MAX_FACT_CHARS} 个字`
  }
  if (looksLikePlaintextCredential(text)) return `合并后的事实${PLAINTEXT}`
  if (mentionsPlaceholder(text)) return '合并后的事实里不能带凭据占位符'
  return null
}

// 合并后的策展记忆正文：sources 是合并的几条的正文，Dream 不能新增凭据引用；格式不对的占位符也不收
export function mergedNodeProblem(
  text: string,
  sources: readonly (string | null)[],
): string | null {
  if (!text) return '合并后的正文不能为空'
  if ([...text].length > MERGED_NODE_CHARS) return `合并后的正文不超过 ${MERGED_NODE_CHARS} 个字`
  if (looksLikePlaintextCredential(text)) return `合并后的正文${PLAINTEXT}`
  const { refs, malformed } = scanPlaceholders(text)
  const known = new Set(sources.flatMap((s) => [...placeholderIdentifiers(s ?? '')]))
  if (malformed.length || refs.some((ref) => !known.has(ref.identifier))) {
    return '合并后的正文只能带这几条记忆里本来就有的凭据占位符'
  }
  return null
}

// 提炼的草稿正文
export function draftProblem(text: string): string | null {
  if (!text) return '提炼的正文不能为空'
  if ([...text].length > DRAFT_CHARS) return `提炼的正文不超过 ${DRAFT_CHARS} 个字`
  if (looksLikePlaintextCredential(text)) return `提炼的正文${PLAINTEXT}`
  if (mentionsPlaceholder(text)) return '提炼的正文里不能带凭据占位符'
  return null
}

// 提炼的 disclosure（一行）
export function disclosureProblem(text: string): string | null {
  if ([...text].length > DISCLOSURE_CHARS) return `disclosure 不超过 ${DISCLOSURE_CHARS} 个字`
  if (looksLikePlaintextCredential(text) || mentionsPlaceholder(text)) {
    return 'disclosure 里不能有明文密码、Token 或凭据占位符'
  }
  return null
}
