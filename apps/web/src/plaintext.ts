import {
  ConvertibleValue,
  CREDENTIAL_MATCH_MAX,
  CREDENTIAL_PLACEHOLDER,
  defaultCredentialFields,
  findPlaintextCredentials,
  type ConvertedToCredential,
  type CredentialValueMatch,
  type CredentialValueMatches,
} from '@kioku/contracts'

import { placeholderOf } from './placeholders'
import { storeName, suggestIdentifier as suggestItemIdentifier } from './vault'

// 转存为凭据的对话框：猜出来的值、建议的标识、值在正文里的位置和次数

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

// 按坐标建议一个标识：开头之后的各段连起来，比如 user://nas/admin 是 nas-admin。坐标的段已经只有小写字母、
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

// 建议的名称：记忆的标题，给人看的名字本来就是它；没有标题时用开头之后的那一段
export const suggestName = (memory: { uri: string; title: string }) =>
  memory.title.trim() || (memory.uri.split('://')[1] ?? memory.uri)

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

// 转存做了什么：一整句，模板里中文换行会多出空格。新建的说明写到了哪里（storedIn），
// 给密码库条目起标识与换成已有凭据的另说
export function convertSummary(result: ConvertedToCredential): string {
  const { credential } = result
  const what = !result.created
    ? `已换成凭据「${credential.name}」的字段 ${result.field}`
    : result.storedIn
      ? `已新建凭据「${credential.name}」（${storeName(result.storedIn)}）`
      : `已给密码库条目起标识 ${credential.identifier}`
  const placeholder = placeholderOf(credential.identifier, result.field)
  const done = `${what}，正文中 ${result.replaced} 处已换成 ${placeholder}。`
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

// 只露头尾的预览，例如 ab…yz：核对是哪一处用，不整段显示。按字符算（不切开表情符号），
// 短的少露一些，太短的只给省略号
export function previewValue(value: string): string {
  const chars = [...value]
  if (chars.length < 4) return '…'
  const keep = chars.length >= 12 ? 2 : 1
  return `${chars.slice(0, keep).join('')}…${chars.slice(-keep).join('')}`
}

// 转存的去处：已有凭据的一个字段、还没起标识的密码库条目的一个字段、新建凭据（写到去处或由 Kioku 托管）。
// key 用来做单选的值，同一个值的去处里不重复
export type ConvertDestination =
  | {
      kind: 'credential'
      key: string
      credentialId: string
      identifier: string
      name: string
      field: string
    }
  | {
      kind: 'vault'
      key: string
      connectionId: string
      itemId: string
      itemName: string
      itemField: string
    }
  | { kind: 'new'; key: 'new' }

// 起了标识、这个字段却没有对应到凭据字段的条目：不能直接用，要先在凭据里加上字段对应
export interface UnmappedVaultField {
  itemName: string
  itemField: string
  identifier: string
}

export const NEW_DESTINATION: ConvertDestination = { kind: 'new', key: 'new' }

// 新建凭据时填的：标识、名称、字段名，写进密码库时的网址，到期时间（datetime-local 的本地时间，空的是不到期）。
// expiresBad：到期时间的输入框填了一半（validity.badInput），这时 expires 也是空的
export interface NewCredentialFields {
  identifier: string
  name: string
  field: string
  url: string
  expires: string
  expiresBad: boolean
}

// 密码库的一个条目：同一个条目的几个字段共用一条凭据，起标识按条目记
export const itemKey = (d: { connectionId: string; itemId: string }) =>
  `${d.connectionId}/${d.itemId}`

// 按值查找的结果：值到匹配；读不了的连接数、读不到值的托管凭据数（这些都没比）；查不了时的错误（有一批失败就给）
export interface ValueMatchResult {
  matches: Map<string, CredentialValueMatch>
  unavailableConnections: number
  unreadableCredentials: number
  failure: unknown
}

// 按值查找同值的凭据与条目：不合转存规则的值不查（服务端会整批拒绝），重复的只查一次，
// 一次最多 CREDENTIAL_MATCH_MAX 个，多了分批；结果按请求的顺序对回值。request 是接口调用。
// 一个值都不用查时不发请求，返回 null：调用方手里的失败说明与不可用连接数不该被这次清掉
export async function matchByValue(
  values: readonly string[],
  request: (values: string[]) => Promise<CredentialValueMatches>,
): Promise<ValueMatchResult | null> {
  const wanted = [...new Set(values.filter((v) => ConvertibleValue.safeParse(v).success))]
  if (!wanted.length) return null
  const result: ValueMatchResult = {
    matches: new Map(),
    unavailableConnections: 0,
    unreadableCredentials: 0,
    failure: null,
  }
  const chunks: string[][] = []
  for (let i = 0; i < wanted.length; i += CREDENTIAL_MATCH_MAX) {
    chunks.push(wanted.slice(i, i + CREDENTIAL_MATCH_MAX))
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const found = await request(chunk)
        chunk.forEach((value, i) => {
          const match = found.items[i]
          if (match) result.matches.set(value, match)
        })
        result.unavailableConnections = Math.max(
          result.unavailableConnections,
          found.unavailableConnections,
        )
        result.unreadableCredentials = Math.max(
          result.unreadableCredentials,
          found.unreadableCredentials,
        )
      } catch (err) {
        result.failure = err
      }
    }),
  )
  return result
}

// 给还没起标识的条目建议标识：按条目名称，避开 taken，建议过的条目不再改；建议出的标识加进 taken
export function suggestItemIdentifiers(
  destinations: readonly ConvertDestination[],
  identifiers: Record<string, string>,
  taken: string[],
): void {
  for (const d of destinations) {
    if (d.kind !== 'vault' || identifiers[itemKey(d)] !== undefined) continue
    const identifier = suggestItemIdentifier(d.itemName, taken)
    identifiers[itemKey(d)] = identifier
    taken.push(identifier)
  }
}

// 按值匹配的结果换成可选的去处，顺序就是默认的先后：已有凭据、还没起标识的条目、新建凭据。
// 没有匹配结果（还没查、查不了）时只有新建凭据
export function convertDestinations(match: CredentialValueMatch | undefined): {
  destinations: ConvertDestination[]
  unmapped: UnmappedVaultField[]
} {
  const destinations: ConvertDestination[] = []
  const unmapped: UnmappedVaultField[] = []
  for (const c of match?.credentials ?? []) {
    destinations.push({
      kind: 'credential',
      key: `credential:${c.id}#${c.field}`,
      credentialId: c.id,
      identifier: c.identifier,
      name: c.name,
      field: c.field,
    })
  }
  for (const item of match?.vaultItems ?? []) {
    if (item.credential) {
      unmapped.push({
        itemName: item.itemName,
        itemField: item.itemField,
        identifier: item.credential.identifier,
      })
      continue
    }
    destinations.push({
      kind: 'vault',
      key: `vault:${item.connectionId}/${item.itemId}#${item.itemField}`,
      connectionId: item.connectionId,
      itemId: item.itemId,
      itemName: item.itemName,
      itemField: item.itemField,
    })
  }
  destinations.push(NEW_DESTINATION)
  return { destinations, unmapped }
}

// 给条目起标识之后这个条目字段在凭据里叫什么：和服务端没给字段对应时推出的一样（defaultCredentialFields）。
// 条目的字段列表读不到时只按这一个字段推，固定字段的名字是准的，自定义字段重名时以服务端的结果为准
export function vaultFieldName(itemFields: readonly string[] | null, itemField: string): string {
  const fields = defaultCredentialFields(itemFields?.includes(itemField) ? itemFields : [itemField])
  return fields.find((f) => f.itemField === itemField)?.name ?? 'field'
}

// 把正文里的这几段值换成占位符：出现几处换几处，已有的占位符里的不换，和服务端转存时一个规则。
// 长的先换：短的值恰好是长的值的一部分时，长的那段先成了占位符，短的不会把它切开
export function replaceValues(
  content: string,
  replacements: readonly { value: string; placeholder: string }[],
): string {
  let text = content
  const ordered = [...replacements].sort((a, b) => b.value.length - a.value.length)
  for (const { value, placeholder } of ordered) {
    if (!value) continue
    text = outsidePlaceholders(text)
      .map((part, i, parts) => {
        const replaced = part.text.split(value).join(placeholder)
        const next = parts[i + 1]
        // 两段之间是原来的占位符，原样放回
        return next ? replaced + text.slice(part.start + part.text.length, next.start) : replaced
      })
      .join('')
  }
  return text
}

// 按值查找时有几样没比：读不了的密码库连接、读不到值的托管凭据。都没有时为 null。对不上不等于没有同值的凭据
export function unmatchedNote(counts: {
  unavailableConnections: number
  unreadableCredentials: number
}): string | null {
  const parts = [
    counts.unavailableConnections ? `${counts.unavailableConnections} 个密码库连接不可用` : '',
    counts.unreadableCredentials ? `${counts.unreadableCredentials} 条凭据无法获取值` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join('、')}，未比对` : null
}

// 没比对的说明，放提示层
export const UNMATCHED_HINT =
  '密码库连接恢复后可重新比对；托管凭据无法获取值时（未配置主密钥或无法解密）不参与比对。其中可能有同值的凭据。'
