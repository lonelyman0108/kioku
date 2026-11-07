import { VaultError, type VaultClient } from './bitwarden/types'

// `Deps.vault` 没传时的后备：每次都按连不上报错（测试，以及忘了传它的入口）
export function unavailableVaultClient(): VaultClient {
  const fail = () => Promise.reject(new VaultError('unreachable', '未配置密码库客户端'))
  return {
    login: fail,
    session: () => ({ snapshot: fail, item: fail, items: fail }),
  }
}
