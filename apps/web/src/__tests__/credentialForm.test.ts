import type { ConsoleCredential } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  createBody,
  editableState,
  formProblem,
  mergeReloaded,
  updateBody,
  type CredentialFormInput,
  type CredentialFormMode,
  type CredentialFormState,
} from '../credentialForm'
import { expiresField, type ExpiresField } from '../vault'

const at = (input: string, bad = false): ExpiresField => ({ noExpiry: false, input, bad })

const form = (over: Partial<CredentialFormState> = {}): CredentialFormState => ({
  identifier: 'nas',
  name: 'NAS',
  description: '',
  restrict: false,
  appIds: [],
  url: '',
  expires: expiresField(null),
  needsRotation: false,
  ...over,
})

const credential = (over: Partial<ConsoleCredential> = {}): ConsoleCredential => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  identifier: 'nas',
  name: 'NAS',
  description: null,
  source: 'hosted',
  version: 3,
  expiresAt: null,
  expiry: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  fields: [{ name: 'password', itemField: null }],
  vault: null,
  appIds: null,
  deletedAt: null,
  referenceCount: 0,
  rotationRequestedAt: null,
  valueChangedAt: '2026-11-01T00:00:00Z',
  ...over,
})

const vaultCredential = (over: Partial<ConsoleCredential> = {}) =>
  credential({
    source: 'vault',
    vault: { connectionId: '00000000-0000-4000-8000-0000000000a1', itemId: 'item-1' },
    fields: [
      { name: 'username', itemField: 'login.username' },
      { name: 'password', itemField: 'login.password' },
      { name: 'totp', itemField: 'login.totp' },
    ],
    ...over,
  })

const NEW: CredentialFormMode = { kind: 'new' }
const input = (over: Partial<CredentialFormInput> = {}): CredentialFormInput => ({
  mode: NEW,
  form: form(),
  valueRows: [{ key: 1, name: 'password', value: 'hunter22', existing: false, removed: false }],
  vaultRows: [],
  vaultValues: [],
  ...over,
})
const edit = (origin: ConsoleCredential, over: Partial<CredentialFormInput> = {}) =>
  input({
    mode: { kind: 'edit', origin },
    form: form(editableState(origin)),
    valueRows: origin.fields.map((f, i) => ({
      key: i,
      name: f.name,
      value: '',
      existing: true,
      removed: false,
    })),
    vaultRows:
      origin.source === 'vault'
        ? origin.fields.map((f, i) => ({ key: i, name: f.name, itemField: f.itemField! }))
        : [],
    vaultValues:
      origin.source === 'vault'
        ? origin.fields.map((f) => ({ name: f.name, itemField: f.itemField!, value: '' }))
        : [],
    ...over,
  })

describe('新建', () => {
  it('来源是 new：值写到去处或由 Kioku 托管，请求里不选；网址与到期时间填了才发', () => {
    expect(createBody(input())).toEqual({
      identifier: 'nas',
      name: 'NAS',
      description: null,
      appIds: null,
      source: { kind: 'new', values: { password: 'hunter22' } },
    })
    const body = createBody(
      input({ form: form({ url: ' https://nas.example.com ', expires: at('2026-12-01T08:00') }) }),
    )
    expect(body.source).toEqual({
      kind: 'new',
      values: { password: 'hunter22' },
      url: 'https://nas.example.com',
    })
    expect(body.expiresAt).toBe(new Date('2026-12-01T08:00').toISOString())
    expect(formProblem(input())).toBeNull()
  })

  it('网址按接口的规则检查，不完整的到期时间拦下', () => {
    expect(formProblem(input({ form: form({ url: 'nas.example.com' }) }))).toBe(
      '网址要以 http:// 或 https:// 开头',
    )
    expect(formProblem(input({ form: form({ expires: at('2026-12-01') }) }))).toBe(
      '请填写完整的到期时间',
    )
    // 填了一半：值是空的，badInput 为真
    expect(formProblem(input({ form: form({ expires: at('', true) }) }))).toBe(
      '请填写完整的到期时间',
    )
  })

  it('已经过去的到期时间也收：记下一个已经到期的令牌', () => {
    expect(formProblem(input({ form: form({ expires: at('2020-01-01T00:00') }) }))).toBeNull()
  })

  it('给条目起标识时来源是 vault，网址不发，到期时间照样能设', () => {
    const item = {
      id: 'item-1',
      organizationId: 'o1',
      collectionIds: [],
      name: 'NAS',
      type: 'login' as const,
      fields: ['login.password'],
      revisionDate: '2026-11-01T00:00:00Z',
      credential: null,
    }
    const body = createBody(
      input({
        mode: { kind: 'name-item', connectionId: '00000000-0000-4000-8000-0000000000a1', item },
        form: form({ url: 'https://nas.example.com', expires: at('2026-12-01T08:00') }),
        vaultRows: [{ key: 1, name: 'password', itemField: 'login.password' }],
      }),
    )
    expect(body.source).toEqual({
      kind: 'vault',
      connectionId: '00000000-0000-4000-8000-0000000000a1',
      itemId: 'item-1',
      fields: [{ name: 'password', itemField: 'login.password' }],
    })
    expect(body.expiresAt).toBeDefined()
  })
})

describe('修改', () => {
  it('什么都没改时只带名称、说明与限定应用', () => {
    expect(updateBody(edit(credential()))).toEqual({
      expectedVersion: 3,
      name: 'NAS',
      description: null,
      appIds: null,
    })
  })

  it('到期时间能设、能清除（选不到期）；没改不发', () => {
    const origin = credential({ expiresAt: '2026-12-01T10:30:00.000Z' })
    expect(updateBody(edit(origin))).not.toHaveProperty('expiresAt')
    const cleared = edit(origin)
    cleared.form.expires = { noExpiry: true, input: '', bad: false }
    expect(updateBody(cleared).expiresAt).toBeNull()
    const moved = edit(origin)
    moved.form.expires = at('2027-01-01T00:00')
    expect(updateBody(moved).expiresAt).toBe(new Date('2027-01-01T00:00').toISOString())
  })

  it('到期时间填到一半不当成清除：不发 null，也不能保存', () => {
    const origin = credential({ expiresAt: '2026-12-01T10:30:00.000Z' })
    const half = edit(origin)
    half.form.expires = at('', true)
    expect(updateBody(half)).not.toHaveProperty('expiresAt')
    expect(formProblem(half)).toBe('请填写完整的到期时间')
  })

  it('需要轮换能标、能清除；没变不发', () => {
    const plain = edit(credential())
    plain.form.needsRotation = true
    expect(updateBody(plain).needsRotation).toBe(true)
    const flagged = edit(credential({ rotationRequestedAt: '2026-11-05T00:00:00Z' }))
    expect(updateBody(flagged)).not.toHaveProperty('needsRotation')
    flagged.form.needsRotation = false
    expect(updateBody(flagged).needsRotation).toBe(false)
  })

  it('密码库的值写回原条目：只发填了的字段，不发 null，TOTP 不发', () => {
    const e = edit(vaultCredential())
    e.vaultValues[1]!.value = 'new-pass'
    e.vaultValues[2]!.value = 'JBSWY3DPEHPK3PXP'
    const body = updateBody(e)
    expect(body.values).toEqual({ password: 'new-pass' })
    expect(body).not.toHaveProperty('fields')
    expect(formProblem(e)).toBeNull()
  })

  it('密码库的字段对应与值不能同一次改：值按修改前的字段名对到条目字段', () => {
    const e = edit(vaultCredential())
    e.vaultValues[1]!.value = 'new-pass'
    e.vaultRows[1]!.name = 'pass'
    expect(formProblem(e)).toBe('字段对应与值请分两次修改')
    e.vaultValues[1]!.value = ''
    expect(formProblem(e)).toBeNull()
    expect(updateBody(e).fields).toEqual([
      { name: 'username', itemField: 'login.username' },
      { name: 'pass', itemField: 'login.password' },
      { name: 'totp', itemField: 'login.totp' },
    ])
  })

  it('托管的照旧：改了的发值，删掉的为 null', () => {
    const e = edit(
      credential({
        fields: [
          { name: 'username', itemField: null },
          { name: 'password', itemField: null },
        ],
      }),
    )
    e.valueRows[0]!.removed = true
    e.valueRows[1]!.value = 'new-pass'
    expect(updateBody(e).values).toEqual({ username: null, password: 'new-pass' })
  })
})

describe('409 之后重新读取', () => {
  let n = 100
  const key = () => n++

  it('加的字段与要删的标记都留着，版本换成新读到的；没有冲突', () => {
    const before = credential({
      fields: [
        { name: 'username', itemField: null },
        { name: 'password', itemField: null },
      ],
    })
    const mine = edit(before)
    mine.valueRows[0]!.removed = true
    mine.valueRows.push({
      key: 9,
      name: 'token',
      value: 'abcd1234',
      existing: false,
      removed: false,
    })
    mine.form.description = '改过的说明'
    mine.form.expires = { noExpiry: false, input: '2027-01-01T00:00', bad: false }
    // 别处改了名称与到期时间，版本加一
    const fresh = {
      ...before,
      version: 4,
      name: '别处改的名称',
      expiresAt: '2026-12-25T00:00:00.000Z',
    }
    const { input: merged, conflicts } = mergeReloaded(mine, before, fresh, key)
    expect(conflicts).toEqual([])
    expect(merged.mode).toEqual({ kind: 'edit', origin: fresh })
    expect(merged.valueRows.find((r) => r.name === 'username')!.removed).toBe(true)
    expect(merged.valueRows.find((r) => r.name === 'token')!.value).toBe('abcd1234')
    // 没动过的取新的，动过的留着表单里的
    expect(merged.form.name).toBe('别处改的名称')
    expect(merged.form.description).toBe('改过的说明')
    expect(merged.form.expires.input).toBe('2027-01-01T00:00')
    const body = updateBody(merged)
    expect(body.expectedVersion).toBe(4)
    expect(body.values).toEqual({ username: null, token: 'abcd1234' })
  })

  it('要改的字段在新版本里没了：明确提示，别处新加的字段列出来', () => {
    const before = credential({
      fields: [
        { name: 'username', itemField: null },
        { name: 'password', itemField: null },
      ],
    })
    const mine = edit(before)
    mine.valueRows[0]!.value = 'admin'
    const fresh = {
      ...before,
      version: 4,
      fields: [
        { name: 'password', itemField: null },
        { name: 'pin', itemField: null },
      ],
    }
    const { input: merged, conflicts } = mergeReloaded(mine, before, fresh, key)
    expect(conflicts).toEqual(['字段 username 已在别处删除'])
    expect(merged.valueRows.map((r) => r.name)).toEqual(['password', 'pin'])
  })

  it('密码库的：填的值按字段名留着；字段对应两边都改了时提示核对', () => {
    const before = vaultCredential()
    const mine = edit(before)
    mine.vaultValues[1]!.value = 'new-pass'
    const fresh = { ...before, version: 4 }
    const kept = mergeReloaded(mine, before, fresh, key)
    expect(kept.conflicts).toEqual([])
    expect(updateBody(kept.input).values).toEqual({ password: 'new-pass' })

    const renamed = edit(before)
    renamed.vaultRows[0]!.name = 'user'
    const theirs = {
      ...before,
      version: 4,
      fields: [{ name: 'password', itemField: 'login.password' }],
    }
    renamed.vaultValues[0]!.value = 'admin'
    const merged = mergeReloaded(renamed, before, theirs, key)
    expect(merged.conflicts).toContain('字段对应在别处也修改过，保存时以表单中的为准，请核对')
    expect(merged.conflicts).toContain('字段 username 的对应已在别处修改，填写的值未保留')
  })

  it('密码库的：别处把 password 改成对应别的条目字段，填的新密码不带过去，报冲突', () => {
    const before = vaultCredential()
    const mine = edit(before)
    mine.vaultValues[1]!.value = 'new-pass'
    const fresh = {
      ...before,
      version: 4,
      fields: [
        { name: 'username', itemField: 'login.username' },
        { name: 'password', itemField: 'login.totp' },
      ],
    }
    const { input: merged, conflicts } = mergeReloaded(mine, before, fresh, key)
    expect(conflicts).toEqual(['字段 password 的对应已在别处修改，填写的值未保留'])
    expect(updateBody(merged)).not.toHaveProperty('values')
  })

  it('密码库的：同一个条目字段在别处改了名，按改名把值带过去；两边改成同一个对应时不报冲突', () => {
    const before = vaultCredential()
    const mine = edit(before)
    mine.vaultValues[1]!.value = 'new-pass'
    const fresh = {
      ...before,
      version: 4,
      fields: [
        { name: 'username', itemField: 'login.username' },
        { name: 'pass', itemField: 'login.password' },
        { name: 'totp', itemField: 'login.totp' },
      ],
    }
    const renamed = mergeReloaded(mine, before, fresh, key)
    expect(renamed.conflicts).toEqual([])
    expect(updateBody(renamed.input).values).toEqual({ pass: 'new-pass' })

    const same = edit(before)
    same.vaultRows[1]!.name = 'pass'
    expect(mergeReloaded(same, before, fresh, key).conflicts).toEqual([])
  })

  it('限定应用是一个整体：一边改了列表、另一边取消了限定，报冲突，不悄悄变成不限定', () => {
    const before = credential({ appIds: ['00000000-0000-4000-8000-0000000000a1'] })
    const mine = edit(before)
    mine.form.appIds = ['00000000-0000-4000-8000-0000000000a2']
    const fresh = { ...before, version: 4, appIds: null }
    const { input: merged, conflicts } = mergeReloaded(mine, before, fresh, key)
    expect(conflicts).toEqual(['限定应用在别处也修改过，保存时以表单中的为准，请核对'])
    expect(merged.form.restrict).toBe(true)
    expect(merged.form.appIds).toEqual(['00000000-0000-4000-8000-0000000000a2'])
    // 只有一边动了：取动了的那边
    const untouched = mergeReloaded(edit(before), before, fresh, key)
    expect(untouched.conflicts).toEqual([])
    expect(untouched.input.form.restrict).toBe(false)
  })

  it('托管的：空的新行和别处新加的字段同名，不报「将改为填写的值」，名字照样能改', () => {
    const before = credential()
    const mine = edit(before)
    mine.valueRows.push({ key: 9, name: 'pin', value: '', existing: false, removed: false })
    const fresh = {
      ...before,
      version: 4,
      fields: [
        { name: 'password', itemField: null },
        { name: 'pin', itemField: null },
      ],
    }
    const { input: merged, conflicts } = mergeReloaded(mine, before, fresh, key)
    expect(conflicts).toEqual([])
    const pins = merged.valueRows.filter((r) => r.name === 'pin')
    expect(pins.map((r) => r.existing).sort()).toEqual([false, true])
    expect(formProblem(merged)).toBe('字段名不能重复')
  })
})
