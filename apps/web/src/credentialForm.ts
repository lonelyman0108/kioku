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

export interface ValueRow {
  key: number
  name: string
  value: string
  existing: boolean
  removed: boolean
}

export interface VaultRow {
  key: number
  name: string
  itemField: string
}

export interface VaultValueRow {
  name: string
  itemField: string
  value: string
}

export interface CredentialFormState {
  identifier: string
  name: string
  description: string
  restrictClients: boolean
  clientIds: string[]
  restrictRealms: boolean
  allowedRealms: string[]
  // 新建时写进密码库条目的网址，托管时服务端不保存
  url: string
  expires: ExpiresField
  needsRotation: boolean
}

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
    restrictClients: c.clientIds !== null,
    clientIds: [...(c.clientIds ?? [])],
    restrictRealms: c.allowedRealms !== null,
    allowedRealms: [...(c.allowedRealms ?? [])],
    expires: expiresField(c.expiresAt),
    needsRotation: c.rotationRequestedAt !== null,
  }
}

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

export function vaultFieldChanges(origin: ConsoleCredential, rows: readonly VaultRow[]) {
  const fields = vaultFields(rows)
  return sameFields(originFields(origin), fields) ? undefined : fields
}

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

const normalizedRealms = (realms: readonly string[]) => [
  ...new Set(realms.map((r) => r.trim().toLowerCase()).filter(Boolean)),
]

export function createBody({ mode, form, valueRows, vaultRows }: CredentialFormInput) {
  const url = form.url.trim()
  const expiresAt = expiresAtOf(form.expires)
  const body: CreateCredentialRequest = {
    identifier: form.identifier,
    name: form.name.trim(),
    description: form.description.trim() || null,
    clientIds: form.restrictClients ? [...form.clientIds] : null,
    allowedRealms: form.restrictRealms ? normalizedRealms(form.allowedRealms) : null,
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
    clientIds: form.restrictClients ? [...form.clientIds] : null,
    allowedRealms: form.restrictRealms ? normalizedRealms(form.allowedRealms) : null,
    ...(values ? { values } : {}),
    ...(fields ? { fields } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(form.needsRotation !== flagged ? { needsRotation: form.needsRotation } : {}),
  }
}

const validName = (name: string) => CREDENTIAL_NAME_PATTERN.test(name)

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
  if (rows.length > MAX_CREDENTIAL_FIELDS) return `一条凭据最多 ${MAX_CREDENTIAL_FIELDS} 个字段`
  const names = rows.map((r) => r.name)
  if (names.some((n) => !validName(n))) {
    return '字段名只能包含小写字母、数字、_ 和 -，且以字母或数字开头'
  }
  if (new Set(names).size !== names.length) return '字段名不能重复'
  if (!vault && liveRows(input.valueRows).some((r) => !r.existing && !r.value)) {
    return '请填写新字段的值'
  }
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
  if (form.restrictClients && !form.clientIds.length) return '限定客户端时至少选择一个'
  if (form.restrictRealms && !normalizedRealms(form.allowedRealms).length) {
    return '限定场域时至少选择一个'
  }
  const result = editing
    ? UpdateCredentialRequest.safeParse(updateBody(input))
    : CreateCredentialRequest.safeParse(createBody(input))
  return result.success ? null : (result.error.issues[0]?.message ?? '填写内容有误')
}

export interface ReloadedForm {
  input: CredentialFormInput
  conflicts: string[]
}

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

  // 限定客户端的开关与列表是一个整体：分别合并会把列表改坏
  const clientScope = (s: { restrictClients: boolean; clientIds: string[] }) => ({
    restrict: s.restrictClients,
    ids: s.restrictClients ? [...s.clientIds].sort() : [],
  })
  const [mineClients, baseClients, theirClients] = [
    clientScope(mine),
    clientScope(base),
    clientScope(theirs),
  ]
  let resolvedClients = mineClients
  if (sameFields(mineClients, baseClients)) resolvedClients = theirClients
  else if (!sameFields(theirClients, baseClients) && !sameFields(theirClients, mineClients)) {
    conflicts.push('限定客户端在别处也修改过，保存时以表单中的为准，请核对')
  }

  // 允许场域（静态场域锁）开关与列表同样按整体合并
  const realmScope = (s: { restrictRealms: boolean; allowedRealms: string[] }) => ({
    restrict: s.restrictRealms,
    realms: s.restrictRealms ? normalizedRealms(s.allowedRealms).sort() : [],
  })
  const [mineRealms, baseRealms, theirRealms] = [
    realmScope(mine),
    realmScope(base),
    realmScope(theirs),
  ]
  let resolvedRealms = mineRealms
  if (sameFields(mineRealms, baseRealms)) resolvedRealms = theirRealms
  else if (!sameFields(theirRealms, baseRealms) && !sameFields(theirRealms, mineRealms)) {
    conflicts.push('允许场域在别处也修改过，保存时以表单中的为准，请核对')
  }

  const form: CredentialFormState = {
    ...mine,
    name: pick('name'),
    description: pick('description'),
    restrictClients: resolvedClients.restrict,
    clientIds: resolvedClients === mineClients ? [...mine.clientIds] : [...theirs.clientIds],
    restrictRealms: resolvedRealms.restrict,
    allowedRealms:
      resolvedRealms === mineRealms ? [...mine.allowedRealms] : [...theirs.allowedRealms],
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
      if (!row.existing && freshNames.has(row.name) && row.name && row.value) {
        conflicts.push(`字段 ${row.name} 已在别处添加，保存时将改为填写的值`)
        valueRows.push({ ...row, existing: true })
        continue
      }
      valueRows.push(row)
    }
    for (const f of fresh.fields) {
      if (!valueRows.some((r) => r.name === f.name && r.existing)) {
        valueRows.push({ key: key(), name: f.name, value: '', existing: true, removed: false })
      }
    }
  }

  let vaultRows = current.vaultRows
  let vaultValues: VaultValueRow[] = []
  if (fresh.source === 'vault') {
    const mineFields = vaultFields(current.vaultRows)
    const baseFields = originFields(before)
    const freshFields = originFields(fresh)
    if (sameFields(mineFields, baseFields)) {
      vaultRows = freshFields.map((f) => ({ key: key(), ...f }))
    } else if (!sameFields(freshFields, baseFields) && !sameFields(freshFields, mineFields)) {
      conflicts.push('字段对应在别处也修改过，保存时以表单中的为准，请核对')
    }
    vaultValues = freshFields.map((f) => ({ ...f, value: '' }))
    for (const row of current.vaultValues) {
      if (!row.value) continue
      const target = vaultValues.find((f) => f.itemField === row.itemField)
      if (target) target.value = row.value
      else conflicts.push(`字段 ${row.name} 的对应已在别处修改，填写的值未保留`)
    }
  }

  return {
    input: { mode: { kind: 'edit', origin: fresh }, form, valueRows, vaultRows, vaultValues },
    conflicts,
  }
}
