import type { VaultConnection } from '@kioku/contracts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { ApiError } from '../../api/client'
import { useVaultLogin } from '../useVaultLogin'

// 接口换成假的，别的都是真的。两步流程与主密码什么时候清空都在这里定，对话框只管长相
const fakes = vi.hoisted(() => ({
  api: { connectVault: vi.fn(), reconnectVault: vi.fn() },
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const connection = (over: Partial<VaultConnection> = {}): VaultConnection => ({
  id: '00000000-0000-4000-8000-000000000001',
  serverUrl: 'https://vault.example.com',
  email: 'agent@example.com',
  status: 'ok',
  disabledReason: null,
  lastError: null,
  lastCheckedAt: null,
  disconnectedAt: null,
  credentialCount: 0,
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  ...over,
})

const onConnected = vi.fn()
function start(target: VaultConnection | null = null) {
  const login = useVaultLogin(ref('s1'), ref(target), onConnected)
  login.reset()
  return login
}
function fill(login: ReturnType<typeof start>) {
  Object.assign(login.form, {
    serverUrl: 'https://vault.example.com/',
    email: 'agent@example.com',
    masterPassword: 'not-a-real-password',
  })
}

beforeEach(() => {
  fakes.api.connectVault.mockReset()
  fakes.api.reconnectVault.mockReset()
  onConnected.mockReset()
})

describe('连接密码库', () => {
  it('没填全时不能提交，提示用接口的说法', () => {
    const login = start()
    expect(login.problem.value).toBe(
      '服务器地址要以 https:// 开头（本机地址与不带点的主机名可以用 http://），不带账号、查询参数与 #',
    )
    fill(login)
    expect(login.problem.value).toBeNull()
  })

  it('一步连上：主密码立即清空，交给页面的是连上的连接与提交时的空间', async () => {
    const conn = connection()
    fakes.api.connectVault.mockResolvedValue({ kind: 'connected', connection: conn })
    const login = start()
    fill(login)
    await login.submit()
    expect(fakes.api.connectVault).toHaveBeenCalledWith('s1', {
      serverUrl: 'https://vault.example.com/',
      email: 'agent@example.com',
      masterPassword: 'not-a-real-password',
    })
    expect(login.form.masterPassword).toBe('')
    expect(onConnected).toHaveBeenCalledWith(conn, 's1')
  })

  it('要两步验证：只填验证码，带着同一份主密码再交一次，交完清空', async () => {
    fakes.api.connectVault.mockResolvedValueOnce({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })
    const login = start()
    fill(login)
    await login.submit()
    expect(login.step.value).toBe('two_factor')
    expect(login.provider.value).toBe('authenticator')
    // 第二次提交还要用，先留着
    expect(login.form.masterPassword).toBe('not-a-real-password')
    expect(login.problem.value).toBe('验证码不能为空')

    login.form.code = '123456'
    await nextTick()
    expect(login.problem.value).toBeNull()
    fakes.api.connectVault.mockResolvedValueOnce({ kind: 'connected', connection: connection() })
    await login.submit()
    expect(fakes.api.connectVault).toHaveBeenLastCalledWith('s1', {
      serverUrl: 'https://vault.example.com/',
      email: 'agent@example.com',
      masterPassword: 'not-a-real-password',
      twoFactor: { provider: 'authenticator', code: '123456' },
    })
    expect(login.form.masterPassword).toBe('')
    expect(login.form.code).toBe('')
    expect(onConnected).toHaveBeenCalledTimes(1)
  })

  it('失败：主密码与验证码都清空，回到第一步，显示服务端的说法', async () => {
    fakes.api.connectVault.mockResolvedValueOnce({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })
    const login = start()
    fill(login)
    await login.submit()
    login.form.code = '000000'
    fakes.api.connectVault.mockRejectedValueOnce(new ApiError(400, '验证码错误'))
    await login.submit()
    expect(login.form.masterPassword).toBe('')
    expect(login.form.code).toBe('')
    expect(login.step.value).toBe('login')
    expect(login.failure.value).toBe('验证码错误')
    expect(onConnected).not.toHaveBeenCalled()
  })

  it('返回上一步与关掉重开都清空主密码', async () => {
    fakes.api.connectVault.mockResolvedValue({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })
    const login = start()
    fill(login)
    await login.submit()
    login.back()
    expect(login.step.value).toBe('login')
    expect(login.form.masterPassword).toBe('')

    fill(login)
    login.reset()
    expect(login.form).toMatchObject({ serverUrl: '', email: '', masterPassword: '', code: '' })
  })

  it('没有受支持的验证方式：主密码清空，说明原因', async () => {
    fakes.api.connectVault.mockResolvedValue({ kind: 'two_factor_required', providers: [] })
    const login = start()
    fill(login)
    await login.submit()
    expect(login.form.masterPassword).toBe('')
    expect(login.failure.value).toBe('不支持此账号的两步验证方式，请为专用账号改用验证器应用')
    expect(login.problem.value).toBe('不支持此账号的两步验证方式')
  })

  it('关掉之后迟到的结果不碰这时的状态', async () => {
    let resolve!: (v: unknown) => void
    fakes.api.connectVault.mockReturnValue(new Promise((r) => (resolve = r)))
    const login = start()
    fill(login)
    const pending = login.submit()
    login.reset()
    resolve({ kind: 'two_factor_required', providers: ['authenticator'] })
    await pending
    expect(login.step.value).toBe('login')
    expect(login.submitting.value).toBe(false)
  })
})

describe('页脚的提示', () => {
  const twoFactor = () =>
    fakes.api.connectVault.mockResolvedValueOnce({
      kind: 'two_factor_required',
      providers: ['authenticator'],
    })

  it('空表单不提示，输入之后提示', () => {
    const login = start()
    expect(login.problem.value).not.toBeNull()
    expect(login.hint.value).toBeNull()
    login.form.serverUrl = 'ftp://vault.example.com'
    expect(login.hint.value).toBe(login.problem.value)
    expect(login.hint.value).not.toBeNull()
  })

  it('重新登录时填回的地址与邮箱不算输入', () => {
    const login = start(connection({ status: 'reauth_required' }))
    expect(login.problem.value).toBe('主密码不能为空')
    expect(login.hint.value).toBeNull()
  })

  it('刚进入两步验证那一步不提示，填过验证码之后才提示', async () => {
    twoFactor()
    const login = start()
    fill(login)
    expect(login.hint.value).toBeNull()
    await login.submit()
    expect(login.step.value).toBe('two_factor')
    expect(login.problem.value).toBe('验证码不能为空')
    expect(login.hint.value).toBeNull()
    login.form.code = '1'
    login.form.code = ''
    expect(login.hint.value).toBe('验证码不能为空')
  })

  it('上一步之后不提示', async () => {
    twoFactor()
    const login = start()
    fill(login)
    await login.submit()
    login.form.code = '1'
    login.back()
    expect(login.problem.value).toBe('主密码不能为空')
    expect(login.hint.value).toBeNull()
  })

  it('失败之后只显示失败原因；改过表单之后提示照常显示', async () => {
    fakes.api.connectVault.mockRejectedValueOnce(new ApiError(400, '邮箱或主密码不正确'))
    const login = start()
    fill(login)
    await login.submit()
    expect(login.failure.value).toBe('邮箱或主密码不正确')
    expect(login.problem.value).toBe('主密码不能为空')
    expect(login.hint.value).toBeNull()

    login.form.email = 'not-an-email'
    expect(login.hint.value).not.toBeNull()
    expect(login.hint.value).toBe(login.problem.value)
    expect(login.failure.value).toBe('邮箱或主密码不正确')
  })

  it('重置之后不提示', () => {
    const login = start()
    login.form.email = 'x'
    expect(login.hint.value).not.toBeNull()
    login.reset()
    expect(login.hint.value).toBeNull()
  })
})

describe('重新登录', () => {
  it('地址与邮箱带上原来的；邮箱没改不发，改了发新的', async () => {
    const conn = connection({ status: 'reauth_required' })
    fakes.api.reconnectVault.mockResolvedValue({ kind: 'connected', connection: connection() })
    const login = start(conn)
    expect(login.form.serverUrl).toBe('https://vault.example.com')
    expect(login.form.email).toBe('agent@example.com')
    login.form.masterPassword = 'not-a-real-password'
    await login.submit()
    expect(fakes.api.reconnectVault).toHaveBeenCalledWith('s1', conn.id, {
      masterPassword: 'not-a-real-password',
    })
    expect(login.form.masterPassword).toBe('')

    login.form.email = 'renamed@example.com'
    login.form.masterPassword = 'not-a-real-password'
    await login.submit()
    expect(fakes.api.reconnectVault).toHaveBeenLastCalledWith('s1', conn.id, {
      email: 'renamed@example.com',
      masterPassword: 'not-a-real-password',
    })
    expect(fakes.api.connectVault).not.toHaveBeenCalled()
  })
})
