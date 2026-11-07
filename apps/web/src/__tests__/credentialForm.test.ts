import type { ConsoleCredential } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import {
  createBody,
  formProblem,
  updateBody,
  type CredentialFormInput,
  type CredentialFormMode,
  type CredentialFormState,
} from '../credentialForm'
import { toLocalInput } from '../time'

const form = (over: Partial<CredentialFormState> = {}): CredentialFormState => ({
  identifier: 'nas',
  name: 'NAS',
  description: '',
  restrict: false,
  appIds: [],
  url: '',
  expires: '',
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
    form: form({
      name: origin.name,
      expires: origin.expiresAt ? toLocalInput(origin.expiresAt) : '',
      needsRotation: origin.rotationRequestedAt !== null,
    }),
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
      input({ form: form({ url: ' https://nas.example.com ', expires: '2026-12-01T08:00' }) }),
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
    expect(formProblem(input({ form: form({ expires: '2026-12-01' }) }))).toBe(
      '请填写完整的到期时间',
    )
  })

  it('已经过去的到期时间也收：记下一个已经到期的令牌', () => {
    expect(formProblem(input({ form: form({ expires: '2020-01-01T00:00' }) }))).toBeNull()
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
        form: form({ url: 'https://nas.example.com', expires: '2026-12-01T08:00' }),
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

  it('到期时间能设、能清除；没改不发', () => {
    const origin = credential({ expiresAt: '2026-12-01T10:30:00.000Z' })
    expect(updateBody(edit(origin))).not.toHaveProperty('expiresAt')
    const cleared = edit(origin)
    cleared.form.expires = ''
    expect(updateBody(cleared).expiresAt).toBeNull()
    const moved = edit(origin)
    moved.form.expires = '2027-01-01T00:00'
    expect(updateBody(moved).expiresAt).toBe(new Date('2027-01-01T00:00').toISOString())
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
