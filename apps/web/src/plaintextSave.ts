import {
  addedPlaintextCredentials,
  findPlaintextCredentials,
  MemoryWriteError,
  type PlaintextCredentialMatch,
  type PlaintextFinding,
  type PlaintextKind,
} from '@kioku/contracts'

import { ApiError } from './api/client'

// 记忆保存之前的逐处处理：这次新增了哪几处疑似明文、按什么分组、保存时带哪个标记

// 要处理的一处。同一个值出现几次只算一处：转存时正文里的这个值出现几处换几处。
// value 为 null 表示服务端指出了这一行、界面上却认不出值（两边的判断有出入），只能选不是凭据
export interface PlaintextSpot {
  value: string | null
  lines: number[]
  kind: PlaintextKind
  // 建议的字段名
  field: string
}

function groupSpots(content: string, matches: readonly PlaintextCredentialMatch[]) {
  const spots: PlaintextSpot[] = []
  const byValue = new Map<string, PlaintextSpot>()
  for (const m of matches) {
    const value = content.slice(m.start, m.end)
    const known = byValue.get(value)
    if (known) {
      if (!known.lines.includes(m.line)) known.lines.push(m.line)
      continue
    }
    const spot: PlaintextSpot = { value, lines: [m.line], kind: m.kind, field: m.field }
    byValue.set(value, spot)
    spots.push(spot)
  }
  return spots
}

// 这次新增的疑似明文，和服务端拒绝写入是同一个判断（addedPlaintextCredentials）。新建时 before 为 null
export const addedSpots = (before: string | null, after: string) =>
  groupSpots(after, addedPlaintextCredentials(before, after))

// 服务端拒绝了、界面上的判断却没有新增时：按服务端给的行号与类别在正文里找。找不到值的那一处照样列出来
export function spotsFromFindings(
  content: string,
  findings: readonly PlaintextFinding[],
): PlaintextSpot[] {
  const all = findPlaintextCredentials(content)
  const found = all.filter((m) => findings.some((f) => f.line === m.line && f.kind === m.kind))
  const spots = groupSpots(content, found)
  for (const f of findings) {
    if (found.some((m) => m.line === f.line && m.kind === f.kind)) continue
    spots.push({ value: null, lines: [f.line], kind: f.kind, field: 'password' })
  }
  return spots
}

// 保存被拒是不是因为疑似明文：是的话给出服务端指出的那几处
export function plaintextRejection(err: unknown): PlaintextFinding[] | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null
  const parsed = MemoryWriteError.safeParse(err.payload)
  return parsed.success && parsed.data.plaintext?.length ? parsed.data.plaintext : null
}

// 一处的选择：转存为凭据或不是凭据
export type SpotChoice = 'convert' | 'ignore'

// 保存时带的标记。照样保存（只给空间所有者）带 allowPlaintext；还有选了不是凭据的带 ignorePlaintext，
// 全部转存之后正文里没有新增的疑似明文，不用带
export type SaveFlags = { allowPlaintext: true } | { ignorePlaintext: true } | Record<string, never>

export function saveFlags(choices: readonly SpotChoice[], allow = false): SaveFlags {
  if (allow) return { allowPlaintext: true }
  return choices.includes('ignore') ? { ignorePlaintext: true } : {}
}

// 第几行，几处合在一起时写「第 2、5 行」
export const linesText = (lines: readonly number[]) =>
  `第 ${[...lines].sort((a, b) => a - b).join('、')} 行`

// 保存被服务端拒绝之后打开哪一份弹窗。正文还是发出去的那份时以服务端为准：本地也认得出的照用，
// 服务端有、本地认不出值的也列出来（spotsFromFindings）。请求期间又改过正文时按现在的正文重算，
// 弹窗的结果只能用在算出它的那份正文上；现在的正文没有新增的就不开弹窗，返回 null
export function spotsAfterRejection(
  before: string | null,
  sent: string,
  current: string,
  findings: readonly PlaintextFinding[],
): { content: string; spots: PlaintextSpot[] } | null {
  if (current === sent) return { content: sent, spots: spotsFromFindings(sent, findings) }
  const spots = addedSpots(before, current)
  return spots.length ? { content: current, spots } : null
}

// 弹窗处理完之后怎么保存：结果是按现在的正文算的就用它；正文在这期间变了，按现在的正文重算，
// 还有新增的就再开一次弹窗，没有了照常保存（不带标记：标记是给算出它的那份正文的）
export type AfterGate =
  { kind: 'save'; content: string; flags: SaveFlags } | { kind: 'reopen'; spots: PlaintextSpot[] }

export function afterGate(
  before: string | null,
  current: string,
  result: { source: string; content: string; flags: SaveFlags },
): AfterGate {
  if (result.source === current) {
    return { kind: 'save', content: result.content, flags: result.flags }
  }
  const spots = addedSpots(before, current)
  return spots.length ? { kind: 'reopen', spots } : { kind: 'save', content: current, flags: {} }
}
