import {
  CREDENTIAL_NAME_PATTERN,
  CreateCredentialRequest,
  MAX_CREDENTIAL_FIELDS,
  UpdateCredentialRequest,
  type ConsoleCredential,
  type VaultItemSummary,
} from '@kioku/contracts'

import { fromLocalInput } from './time'
import {
  expiresChange,
  expiresField,
  expiresProblem,
  writableVaultField,
  type ExpiresField,
} from './vault'

// 凭据表单（新建、给条目起标识、修改）的请求怎么拼、哪里不对、409 之后怎么和新读到的合起来。对话框只管长相

// 带值的一行（新建，或者修改托管的）：existing 表示修改时已有的字段，值留空就是不改，removed 表示删掉它
export interface ValueRow {
  key: number
  name: string
  value: string
  existing: boolean
  removed: boolean
}
// 密码库的一行：凭据里的字段名对应条目里的哪个字段
export interface VaultRow {
  key: number
  name: string
  itemField: string
}
// 修改密码库凭据的值：按修改前的字段名，值写回对应的条目字段；留空不改
export interface VaultValueRow {
  name: string
  itemField: string
  value: string
}

export interface CredentialFormState {
  identifier: string
  name: string
  description: string
  restrict: boolean
  appIds: string[]
  // 新建时写进密码库条目的网址，托管时服务端不保存
  url: string
  expires: ExpiresField
  needsRotation: boolean
}

// 表单在哪种情况下：新建（值写到去处或托管）、给条目起标识、修改
export type CredentialFormMode =
  | { kind: 'new' }
  | { kind: 'name-item'; connectionId: string; item: VaultItemSummary }
  | { kind: 'edit'; origin: ConsoleCredential }

export interface CredentialFormInput {
  mode: CredentialFormMode
  form: CredentialFormState
  valueRows: ValueRow[]
  vaultRows: VaultRow[]
  vaultValues: VaultValueRow[]
}

const isVault = (mode: CredentialFormMode) =>
  mode.kind === 'name-item' || (mode.kind === 'edit' && mode.origin.source === 'vault')

const liveRows = (rows: readonly ValueRow[]) => rows.filter((r) => !r.removed)

// 修改时按凭据填的表单项（标识与网址只在新建时有）
export function editableState(
  c: ConsoleCredential,
): Omit<CredentialFormState, 'identifier' | 'url'> {
  return {
    name: c.name,
    description: c.description ?? '',
    restrict: c.appIds !== null,
    appIds: [...(c.appIds ?? [])],
    expires: expiresField(c.expiresAt),
    needsRotation: c.rotationRequestedAt !== null,
  }
}

// 修改托管的值：只发改了的字段，删掉的为 null
export function hostedChanges(
  rows: readonly ValueRow[],
): Record<string, string | null> | undefined {
  const values: Record<string, string | null> = {}
  for (const row of rows) {
    if (row.existing && row.removed) values[row.name] = null
    else if (!row.removed && row.value) values[row.name] = row.value
  }
  return Object.keys(values).length ? values : undefined
}

const vaultFields = (rows: readonly VaultRow[]) =>
  rows.map((r) => ({ name: r.name, itemField: r.itemField }))
const originFields = (origin: ConsoleCredential) =>
  origin.fields.flatMap((f) => (f.itemField ? [{ name: f.name, itemField: f.itemField }] : []))
const sameFields = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// 修改密码库的字段对应：整个替换，没改就不发
export function vaultFieldChanges(origin: ConsoleCredential, rows: readonly VaultRow[]) {
  const fields = vaultFields(rows)
  return sameFields(originFields(origin), fields) ? undefined : fields
}

// 写回密码库条目的值：只发填了的、能改的字段；不能删字段，所以没有 null
export function vaultValueChanges(
  rows: readonly VaultValueRow[],
): Record<string, string> | undefined {
  const values: Record<string, string> = {}
  for (const row of rows) {
    if (row.value && writableVaultField(row)) values[row.name] = row.value
  }
  return Object.keys(values).length ? values : undefined
}

const expiresAtOf = (field: ExpiresField) =>
  field.noExpiry || field.bad ? undefined : (fromLocalInput(field.input) ?? undefined)

export function createBody({ mode, form, valueRows, vaultRows }: CredentialFormInput) {
  const url = form.url.trim()
  const expiresAt = expiresAtOf(form.expires)
  const body: CreateCredentialRequest = {
    identifier: form.identifier,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    source:
      mode.kind === 'name-item'
        ? {
            kind: 'vault',
            connectionId: mode.connectionId,
            itemId: mode.item.id,
            fields: vaultFields(vaultRows),
          }
        : {
            kind: 'new',
            values: Object.fromEntries(liveRows(valueRows).map((r) => [r.name, r.value])),
            ...(url ? { url } : {}),
          },
    ...(expiresAt ? { expiresAt } : {}),
  }
  return body
}

export function updateBody({
  mode,
  form,
  valueRows,
  vaultRows,
  vaultValues,
}: CredentialFormInput): UpdateCredentialRequest {
  const origin = mode.kind === 'edit' ? mode.origin : null
  const vault = isVault(mode)
  const values = vault ? vaultValueChanges(vaultValues) : hostedChanges(valueRows)
  const fields = vault && origin ? vaultFieldChanges(origin, vaultRows) : undefined
  const expiresAt = expiresChange(origin?.expiresAt ?? null, form.expires)
  const flagged = origin?.rotationRequestedAt != null
  return {
    expectedVersion: origin?.version ?? 0,
    name: form.name.trim(),
    description: form.description.trim() || null,
    appIds: form.restrict ? [...form.appIds] : null,
    ...(values ? { values } : {}),
    ...(fields ? { fields } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(form.needsRotation !== flagged ? { needsRotation: form.needsRotation } : {}),
  }
}

const validName = (name: string) => CREDENTIAL_NAME_PATTERN.test(name)

// 提交前在界面上能看出来的问题；服务端照样会检查。其余规则（长度、网址的写法等）直接用接口的定义检查，提示与服务端一致
export function formProblem(input: CredentialFormInput): string | null {
  const { mode, form } = input
  const editing = mode.kind === 'edit'
  const vault = isVault(mode)
  if (!editing && !validName(form.identifier)) {
    return '标识只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  }
  if (!form.name.trim()) return '名称不能为空'
  const rows = vault ? input.vaultRows : liveRows(input.valueRows)
  if (!rows.length) return '至少需要一个字段'
  // 修改托管的只发改了的字段，合并之后的总数要在这里看
  if (rows.length > MAX_CREDENTIAL_FIELDS) return `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`
  const names = rows.map((r) => r.name)
  if (names.some((n) => !validName(n)))
    return '字段名只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  if (new Set(names).size !== names.length) return '字段名不能重复'
  if (!vault && liveRows(input.valueRows).some((r) => !r.existing && !r.value)) {
    return '请填写新字段的值'
  }
  // 写回的值按修改前的字段名对到条目字段：同时改名会对不上，分两次改
  if (
    mode.kind === 'edit' &&
    vault &&
    vaultValueChanges(input.vaultValues) &&
    vaultFieldChanges(mode.origin, input.vaultRows)
  ) {
    return '字段对应与值请分两次修改'
  }
  const expires = expiresProblem(form.expires)
  if (expires) return expires
  if (form.restrict && !form.appIds.length) return '限定应用时至少选择一个'
  const result = editing
    ? UpdateCredentialRequest.safeParse(updateBody(input))
    : CreateCredentialRequest.safeParse(createBody(input))
  return result.success ? null : (result.error.issues[0]?.message ?? '填写内容有误')
}

// ---- 409 之后重新读取 ----

export interface ReloadedForm {
  input: CredentialFormInput
  // 合不起来的地方，逐条告诉人；为空时表示新读到的一版和表单里的改动没有冲突
  conflicts: string[]
}

// 重新读取之后：只换掉服务端的那一份（版本、字段与字段对应、到期与轮换的现状），表单里做过的改动都留着，再和新的一版合起来。
// 按三方合并：表单里某一项和打开时（before）一样，说明没动过，取新读到的（fresh）；动过的留着表单里的。
// 要改的字段在新版本里没了、两边都改了字段对应这类合不起来的，写进 conflicts。key 给新加的行编号
export function mergeReloaded(
  current: CredentialFormInput,
  before: ConsoleCredential,
  fresh: ConsoleCredential,
  key: () => number,
): ReloadedForm {
  const conflicts: string[] = []
  const base = editableState(before)
  const theirs = editableState(fresh)
  const mine = current.form
  const pick = <K extends keyof typeof base>(k: K): (typeof base)[K] =>
    sameFields(mine[k], base[k]) ? theirs[k] : mine[k]
  const form: CredentialFormState = {
    ...mine,
    name: pick('name'),
    description: pick('description'),
    restrict: pick('restrict'),
    appIds: pick('appIds'),
    expires: pick('expires'),
    needsRotation: pick('needsRotation'),
  }

  const freshNames = new Set(fresh.fields.map((f) => f.name))
  let valueRows = current.valueRows
  if (fresh.source === 'hosted') {
    valueRows = []
    for (const row of current.valueRows) {
      if (row.existing && !freshNames.has(row.name)) {
        if (row.value || row.removed) conflicts.push(`字段 ${row.name} 已在别处删除`)
        continue
      }
      if (!row.existing && freshNames.has(row.name) && row.name) {
        conflicts.push(`字段 ${row.name} 已在别处添加，保存时将改为填写的值`)
        valueRows.push({ ...row, existing: true })
        continue
      }
      valueRows.push(row)
    }
    for (const f of fresh.fields) {
      if (!valueRows.some((r) => r.name === f.name)) {
        valueRows.push({ key: key(), name: f.name, value: '', existing: true, removed: false })
      }
    }
  }

  let vaultRows = current.vaultRows
  let vaultValues: VaultValueRow[] = []
  if (fresh.source === 'vault') {
    const mineFields = vaultFields(current.vaultRows)
    const freshFields = originFields(fresh)
    if (sameFields(mineFields, originFields(before))) {
      vaultRows = freshFields.map((f) => ({ key: key(), ...f }))
    } else if (!sameFields(freshFields, originFields(before))) {
      conflicts.push('字段对应在别处也修改过，保存时以表单中的为准，请核对')
    }
    const typed = new Map(current.vaultValues.map((r) => [r.name, r.value] as const))
    vaultValues = freshFields.map((f) => ({ ...f, value: typed.get(f.name) ?? '' }))
    for (const [name, value] of typed) {
      if (value && !freshFields.some((f) => f.name === name)) {
        conflicts.push(`字段 ${name} 已在别处删除，填写的值未保留`)
      }
    }
  }

  return {
    input: { mode: { kind: 'edit', origin: fresh }, form, valueRows, vaultRows, vaultValues },
    conflicts,
  }
}
