import { VaultError, type VaultClient } from './bitwarden/types'

// 还没接上 Bitwarden 客户端时用的占位：每次调用都按连不上服务器报错，连接与取用都以「密码库无法连接」失败
export function unavailableVaultClient(): VaultClient {
  const fail = () => Promise.reject(new VaultError('unreachable', '密码库客户端尚未接入'))
  return {
    login: fail,
    session: () => ({ snapshot: fail, item: fail }),
  }
}
