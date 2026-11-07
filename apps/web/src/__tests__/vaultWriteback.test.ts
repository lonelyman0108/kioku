import {
  CREDENTIAL_HOSTED_NAME,
  VAULT_ERROR_KIND_NAMES,
  type ConsoleCredential,
  type VaultConnection,
} from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../api/client'
import convertModal from '../components/ConvertCredentialModal.vue?raw'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import credentialForm from '../components/CredentialFormModal.vue?raw'
import inboxCredentials from '../components/InboxCredentials.vue?raw'
import saveModal from '../components/PlaintextSaveModal.vue?raw'
import vaultPanel from '../components/VaultConnectionPanel.vue?raw'
import { credentialChangeLabels } from '../labels'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import { toLocalInput } from '../time'
import vaultSource from '../vault?raw'
import {
  attentionNotes,
  credentialFlags,
  destinationChoices,
  destinationConnection,
  destinationProblem,
  expiresChange,
  expiresField,
  expiresInput,
  expiresInputBad,
  expiresProblem,
  isLoginFields,
  newCredentialStore,
  orphanNotice,
  optionalExpiresProblem,
  orphanVaultItem,
  storeName,
  writableVaultField,
  type ExpiresField,
} from '../vault'

const conn = (over: Partial<VaultConnection> = {}): VaultConnection => ({
  id: '00000000-0000-4000-8000-000000000001',
  serverUrl: 'https://vault.example.com',
  email: 'agent@example.com',
  status: 'ok',
  disabledReason: null,
  lastError: null,
  lastCheckedAt: null,
  disconnectedAt: null,
  credentialCount: 0,
  destination: null,
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  ...over,
})
const destination = { collectionId: 'c1', organizationId: 'o1', collectionName: 'Agent' }

describe('新凭据的去处', () => {
  it('设了去处的连接写进那个集合，没有时由 Kioku 托管；连接没读到时不下结论', () => {
    const withDest = conn({ id: '00000000-0000-4000-8000-000000000002', destination })
    expect(destinationConnection([conn(), withDest])).toBe(withDest)
    expect(newCredentialStore([conn(), withDest])).toEqual({
      kind: 'vault',
      connection: withDest,
      collectionName: 'Agent',
    })
    expect(newCredentialStore([conn()])).toEqual({ kind: 'hosted' })
    expect(newCredentialStore([])).toEqual({ kind: 'hosted' })
    expect(newCredentialStore(undefined)).toBeNull()
  })

  it('写到哪里的名字：去处与结果同一个说法，托管用契约的「Kioku 托管」', () => {
    expect(storeName({ kind: 'hosted' })).toBe(CREDENTIAL_HOSTED_NAME)
    expect(storeName({ kind: 'vault', collectionName: 'Agent' })).toBe('密码库集合「Agent」')
    expect(storeName({ kind: 'hosted', bench: false })).toBe('Kioku 托管')
    expect(storeName({ kind: 'vault', collectionName: 'Agent' })).toBe('密码库集合「Agent」')
  })

  it('连接不可用时去处照样留着，提示新建会失败', () => {
    expect(destinationProblem(conn({ destination }))).toBeNull()
    expect(destinationProblem(conn({ status: 'reauth_required', destination }))).toBe(
      '连接需要重新登录，恢复前新建凭据将失败',
    )
    expect(
      destinationProblem(
        conn({ status: 'disabled', disabledReason: 'personal_items', destination }),
      ),
    ).toBe('连接已停用：有个人条目，恢复前新建凭据将失败')
    expect(destinationProblem(conn({ status: 'disconnected', destination }))).toContain('已断开')
    // 没设去处时不提示
    expect(destinationProblem(conn({ status: 'disconnected' }))).toBeNull()
  })

  it('同步读到的集合里没有它或者它变成只读时提示更改或清除；没读到集合时只看连接', () => {
    const c = conn({ destination })
    expect(destinationProblem(c, [])).toContain('集合不可用')
    expect(
      destinationProblem(c, [{ id: 'c1', organizationId: 'o1', name: 'Agent', readOnly: true }]),
    ).toContain('集合只读')
    expect(
      destinationProblem(c, [{ id: 'c1', organizationId: 'o1', name: 'Agent', readOnly: false }]),
    ).toBeNull()
    expect(destinationProblem(c, undefined)).toBeNull()
  })

  it('选去处时按名称排，只读的列出来但不能选', () => {
    expect(
      destinationChoices([
        { id: 'c2', organizationId: 'o1', name: 'Ops', readOnly: true },
        { id: 'c1', organizationId: 'o1', name: 'Agent', readOnly: false },
      ]),
    ).toEqual([
      { id: 'c1', name: 'Agent', disabled: false },
      { id: 'c2', name: 'Ops', disabled: true },
    ])
  })

  it('连接上的去处：显示、设与清除，设好之后按返回的连接列表整个换掉', () => {
    expect(vaultPanel).toContain('集合「{{ c.destination.collectionName }}」')
    expect(vaultPanel).toContain("queryClient.setQueryData(['vault-connections', sid], list)")
    expect(vaultPanel).toContain('api.setVaultDestination(sid, c.value.id, { collectionId })')
    expect(vaultPanel).toContain('api.clearVaultDestination(sid, c.value.id)')
    // 连接不可用时去处照样显示：显示的条件不看连接的状态
    expect(vaultPanel).toContain('v-if="c.destination || canChooseDestination"')
    expect(vaultPanel).toContain(':disabled="x.disabled"')
  })

  it('最近的错误用契约的说法，不再另写一份', () => {
    expect(vaultSource).not.toContain("read_only: '集合只读'")
    expect(vaultPanel).toContain('VAULT_ERROR_KIND_NAMES[c.lastError.kind]')
    expect(VAULT_ERROR_KIND_NAMES.item_conflict).toBe('条目已在别处修改')
  })
})

describe('写进密码库却没建成凭据', () => {
  const item = {
    connectionId: '00000000-0000-4000-8000-000000000001',
    itemId: 'i1',
    itemName: 'NAS',
    collectionName: 'Agent',
  }

  it('从错误体里取出留下的条目；别的错误没有', () => {
    expect(
      orphanVaultItem(new ApiError(409, '标识已被占用', { error: 'x', vaultItem: item })),
    ).toEqual(item)
    expect(orphanVaultItem(new ApiError(409, '标识已被占用', { error: 'x' }))).toBeNull()
    expect(orphanVaultItem(new ApiError(500, 'x', null))).toBeNull()
    expect(orphanVaultItem(new Error('x'))).toBeNull()
  })

  it('说明条目留在哪个集合、叫什么，可以起标识或删掉，重试会另建一个', () => {
    const notice = orphanNotice(item)
    expect(notice.title).toBe('条目「NAS」已写进集合「Agent」，凭据未建成')
    expect(notice.detail).toContain('起标识')
    expect(notice.detail).toContain('删除')
    expect(notice.detail).toContain('另建一个条目')
  })

  it('新建、转存与保存前处理都提示它，失败的原因与下一步照样显示，不被条目的提示压住', () => {
    for (const source of [credentialForm, convertModal, saveModal]) {
      expect(source).toContain('orphanNotice(orphan.value)')
      expect(source).toMatch(/<NoteLine v-if="failure"/)
      expect(source).not.toContain('v-else-if="failure"')
    }
    // 409 之后的重新读取也还在
    expect(convertModal).toMatch(/<NoteLine v-if="failure"[\s\S]*?v-if="canReload"/)
    expect(credentialForm).toMatch(/<NoteLine v-if="failure"[\s\S]*?@click="reload"/)
  })
})

describe('去处的几处共用一份', () => {
  it('转存与保存前处理不再自己读连接列表，去处读取失败时说明', () => {
    for (const source of [convertModal, saveModal]) {
      expect(source).not.toContain("['vault-connections'")
      expect(source).toContain(':store-failed="storeFailed"')
    }
    expect(credentialForm).toContain('useNewCredentialStore(')
    expect(credentialForm).toContain('storeLabel(store, storeFailed)')
    expect(vaultSource).not.toContain('storedInName')
  })

  it('去处的警告色在 scoped 里给：scoped 的 color 压得过 text-warning', () => {
    expect(vaultPanel).not.toContain('conn-error text-warning')
    expect(vaultPanel).toContain('class="conn-error is-warning"')
    expect(vaultPanel).toMatch(/\.conn-error\.is-warning \{\s+color: var\(--ui-warning\);/)
  })

  it('设去处失败时条目列表里的集合一起重读，不然同一个集合还能选', () => {
    const save = vaultPanel.slice(vaultPanel.indexOf('async function saveDestination'))
    const failed = save.slice(save.indexOf('} catch'), save.indexOf('} finally'))
    expect(failed).toContain("queryKey: ['vault-items', sid, c.value.id]")
  })

  it('条目列表都经 fetchVaultItems 读：读到之后凭据与待处理的条数跟着失效', () => {
    for (const source of [vaultPanel, credentialDetail, credentialForm]) {
      expect(source).toContain('fetchVaultItems(queryClient, sid, id')
      expect(source).not.toContain('api.vaultItems(')
    }
  })

  it('标记的样式只有一份', () => {
    for (const source of [credentialDetail, credentialsPage, inboxCredentials]) {
      expect(source).toContain('<FlagTag')
      expect(source).not.toMatch(/\.(row|detail|cred|bench)-flag \{/)
    }
  })

  it('待处理的说明不再讲一遍范围；「可选」不是句子，不带句号', () => {
    expect(inboxCredentials).not.toContain('仅列出当前账号')
    expect(credentialForm).toContain('可选<Hint>')
    expect(credentialForm).not.toContain('可选。')
  })
})

describe('到期与轮换', () => {
  const credential = (over: Partial<ConsoleCredential> = {}) =>
    ({ expiresAt: null, expiry: null, rotationRequestedAt: null, ...over }) as ConsoleCredential

  it('标记用契约的说法：快到期或已到期、需要轮换', () => {
    expect(credentialFlags(credential())).toEqual([])
    expect(
      credentialFlags(
        credential({
          expiresAt: '2026-11-10T00:00:00Z',
          expiry: 'expiring',
          rotationRequestedAt: '2026-11-01T00:00:00Z',
        }),
      ),
    ).toEqual(['快到期', '需要轮换'])
    expect(credentialFlags(credential({ expiry: 'expired' }))).toEqual(['已到期'])
  })

  it('待处理里说什么时候到期、什么时候标的', () => {
    const now = new Date('2026-11-08T00:00:00Z')
    const notes = attentionNotes(
      credential({
        expiresAt: '2026-11-10T00:00:00Z',
        expiry: 'expiring',
        rotationRequestedAt: '2026-11-01T00:00:00Z',
      }),
      now,
    )
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/到期$/)
    expect(notes[1]).toMatch(/标记需要轮换$/)
    expect(
      attentionNotes(credential({ expiresAt: '2026-11-01T00:00:00Z', expiry: 'expired' }), now)[0],
    ).toMatch(/已到期$/)
  })

  const at = (input: string, bad = false): ExpiresField => ({ noExpiry: false, input, bad })
  const none: ExpiresField = { noExpiry: true, input: '', bad: false }

  it('到期时间：没改不发，选了不到期发 null，改了发带时区的时间；按分钟比较', () => {
    const iso = '2026-12-01T10:30:00.000Z'
    expect(expiresInput(null)).toBe('')
    expect(expiresField(null)).toEqual(none)
    expect(expiresField(iso)).toEqual(at(toLocalInput(iso)))
    expect(expiresChange(iso, at(toLocalInput(iso)))).toBeUndefined()
    // 秒被输入框截掉，照样算没改
    expect(expiresChange('2026-12-01T10:30:42.000Z', at(toLocalInput(iso)))).toBeUndefined()
    expect(expiresChange(iso, none)).toBeNull()
    expect(expiresChange(null, none)).toBeUndefined()
    expect(expiresChange(null, at('2026-12-01T08:00'))).toBe(
      new Date('2026-12-01T08:00').toISOString(),
    )
  })

  it('输入框填了一半时值是空的，不能当成清除：原来的到期时间不发 null', () => {
    const iso = '2026-12-01T10:30:00.000Z'
    expect(expiresChange(iso, at('', true))).toBeUndefined()
    expect(expiresChange(iso, at(''))).toBeUndefined()
    expect(expiresProblem(at('', true))).toBe('请填写完整的到期时间')
    expect(expiresProblem(at(''))).toBe('请填写完整的到期时间')
    expect(expiresProblem(at('2026-12-01'))).toBe('请填写完整的到期时间')
    expect(expiresProblem(at('2026-12-01T08:00'))).toBeNull()
    expect(expiresProblem(none)).toBeNull()
  })

  it('新建时可选的到期时间：空的是不到期，填了一半照样拦下', () => {
    expect(optionalExpiresProblem('', false)).toBeNull()
    expect(optionalExpiresProblem('', true)).toBe('请填写完整的到期时间')
    expect(optionalExpiresProblem('2026-12-01T08:00', false)).toBeNull()
  })

  it('认出填了一半的输入框：看 validity.badInput', () => {
    const event = (badInput: boolean) =>
      ({ target: { validity: { badInput } } }) as unknown as Event
    expect(expiresInputBad(event(true))).toBe(true)
    expect(expiresInputBad(event(false))).toBe(false)
    expect(expiresInputBad({ target: null } as unknown as Event)).toBe(false)
  })

  it('表单里清除是单独的「不到期」按钮，输入框绑着 badInput', () => {
    expect(credentialForm).toContain('v-model="form.expires.input"')
    expect(credentialForm).toContain("form.expires = { noExpiry: true, input: '', bad: false }")
    expect(credentialForm).toContain('(form.expires.bad = expiresInputBad(e))')
    for (const source of [convertModal, saveModal]) {
      expect(source).toContain('@fresh-expires-bad=')
    }
  })

  it('修改记录里的到期时间与需要轮换有名字', () => {
    expect(credentialChangeLabels.expiresAt).toBe('到期时间')
    expect(credentialChangeLabels.needsRotation).toBe('需要轮换')
  })

  it('详情列出到期时间、需要轮换与上次改值，记录可以只看上次改值以来的取用', () => {
    expect(credentialDetail).toContain("{ key: 'changed', label: '上次改值' }")
    expect(credentialDetail).toContain('CREDENTIAL_EXPIRY_NAMES[c.expiry]')
    expect(credentialDetail).toContain(
      "['credential-events', props.spaceId, c.value.id, { since: sinceChange.value }]",
    )
    expect(credentialDetail).toContain('api.credentialEvents(spaceId, id, pageParam, f.since)')
  })

  it('改了到期时间、需要轮换、值或删除之后，待处理的条数失效', () => {
    const refresh = credentialsPage.slice(credentialsPage.indexOf('async function refreshLists'))
    expect(refresh.slice(0, refresh.indexOf('\n}\n'))).toContain(
      'invalidateInboxCounts(queryClient, sid)',
    )
    expect(credentialsPage).toContain('@saved="onSaved"')
    expect(credentialsPage).toMatch(/function onSaved[\s\S]*?void refreshLists\(sid\)/)
  })

  it('待处理的凭据列表用 attention 筛选，和凭据列表同一个前缀', () => {
    expect(inboxCredentials).toContain("api.credentials(sid, { attention: 'true' })")
    expect(inboxCredentials).toContain('attentionCredentialsKey(props.spaceId)')
  })
})

describe('写回密码库', () => {
  it('TOTP 密钥不由 Kioku 改', () => {
    expect(writableVaultField({ itemField: 'login.totp' })).toBe(false)
    expect(writableVaultField({ itemField: 'login.password' })).toBe(true)
    expect(writableVaultField({ itemField: 'field:api_key' })).toBe(true)
  })

  it('有 username 或 password 字段的写成登录条目', () => {
    expect(isLoginFields(['username', 'password'])).toBe(true)
    expect(isLoginFields(['password'])).toBe(true)
    expect(isLoginFields(['token'])).toBe(false)
  })

  it('409 时留在表单里，可以一键重新读取；重新读取和表单里的改动合起来，不重建表单', () => {
    expect(credentialForm).toContain('conflict.value = true')
    expect(credentialForm).toContain('const fresh = await api.credential(spaceId, before.id)')
    expect(credentialForm).toContain('mergeReloaded(input(), before, fresh')
    expect(credentialForm).not.toMatch(/function reload[\s\S]*?fill\(fresh/)
    expect(credentialForm).toContain('@click="reload"')
  })

  it('新建的结果按 storedIn 说明写到了哪里', () => {
    expect(credentialForm).toContain('stored = storeName(storedIn)')
    expect(saveModal).toContain('storeName(s.storedIn)')
  })
})
