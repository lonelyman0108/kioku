import {
  ConnectVaultRequest,
  ReconnectVaultRequest,
  type VaultConnection,
  type VaultTwoFactorProvider,
} from '@kioku/contracts'
import { computed, reactive, ref, type Ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'

// 连接与重新登录密码库：先交服务器地址、邮箱与主密码；服务器要两步验证时再填验证码（只支持验证器应用），
// 带着同一份主密码再交一次。
// 主密码只在这里的局部状态里，不进查询缓存、地址或本地存储：连上、失败、返回上一步或关掉都立即清空；
// 只有等验证码的那一步留着它，第二次提交还要用
export function useVaultLogin(
  spaceId: Ref<string>,
  // 重新登录的连接；null 是新建连接
  target: Ref<VaultConnection | null>,
  onConnected: (connection: VaultConnection, spaceId: string) => void,
) {
  const form = reactive({ serverUrl: '', email: '', masterPassword: '', code: '' })
  const step = ref<'login' | 'two_factor'>('login')
  // 服务器给的可用方式里第一个；只支持验证器应用，界面上不让选
  const provider = ref<VaultTwoFactorProvider | undefined>(undefined)
  const submitting = ref(false)
  const failure = ref<string | null>(null)
  // 每次提交一个序号：关掉、返回之后迟到的结果不碰这时的状态
  let submitId = 0

  // 打开时：重新登录的带上原来的地址与邮箱，别的都清掉
  function reset() {
    submitId++
    const c = target.value
    Object.assign(form, {
      serverUrl: c?.serverUrl ?? '',
      email: c?.email ?? '',
      masterPassword: '',
      code: '',
    })
    step.value = 'login'
    provider.value = undefined
    submitting.value = false
    failure.value = null
  }

  // 回到第一步：验证码作废，主密码要重新填
  function back() {
    submitId++
    submitting.value = false
    step.value = 'login'
    form.masterPassword = ''
    form.code = ''
    failure.value = null
  }

  const twoFactor = () =>
    step.value === 'two_factor' && provider.value
      ? { provider: provider.value, code: form.code }
      : undefined

  function body(): ConnectVaultRequest | ReconnectVaultRequest {
    const tf = twoFactor()
    if (target.value) {
      return {
        // 邮箱在密码库里改过时给新的，没改不发
        ...(form.email.trim() !== target.value.email ? { email: form.email } : {}),
        masterPassword: form.masterPassword,
        ...(tf ? { twoFactor: tf } : {}),
      }
    }
    return {
      serverUrl: form.serverUrl,
      email: form.email,
      masterPassword: form.masterPassword,
      ...(tf ? { twoFactor: tf } : {}),
    }
  }

  // 提交前在界面上能看出来的问题，规则用接口的定义，提示与服务端一致
  const problem = computed<string | null>(() => {
    if (step.value === 'two_factor' && !provider.value) return '不支持此账号的两步验证方式'
    const parsed = target.value
      ? ReconnectVaultRequest.safeParse(body())
      : ConnectVaultRequest.safeParse(body())
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? '填写内容有误')
  })

  async function submit() {
    if (submitting.value || problem.value) return
    const id = ++submitId
    const sid = spaceId.value
    const c = target.value
    const request = body()
    submitting.value = true
    failure.value = null
    try {
      const result = c
        ? await api.reconnectVault(sid, c.id, request as ReconnectVaultRequest)
        : await api.connectVault(sid, request as ConnectVaultRequest)
      if (id !== submitId) return
      if (result.kind === 'two_factor_required') {
        // 主密码留到第二次提交
        step.value = 'two_factor'
        provider.value = result.providers[0]
        form.code = ''
        if (!provider.value) {
          form.masterPassword = ''
          failure.value = '不支持此账号的两步验证方式，请为专用账号改用验证器应用'
        }
        return
      }
      form.masterPassword = ''
      form.code = ''
      onConnected(result.connection, sid)
    } catch (err) {
      if (id !== submitId) return
      form.masterPassword = ''
      form.code = ''
      // 主密码清掉了，验证码这一步也接不下去，回到第一步重新填
      step.value = 'login'
      failure.value = err instanceof ApiError ? err.message : '连接失败'
    } finally {
      if (id === submitId) submitting.value = false
    }
  }

  return { form, step, provider, submitting, failure, problem, reset, back, submit }
}
