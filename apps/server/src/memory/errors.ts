import type { CredentialWriteReason, OrphanVaultItem, PlaintextFinding } from '@kioku/contracts'

export class MemoryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429 | 500 | 502,
    message: string,
    // 正文里有新增的疑似明文被拒时的每一处（行号与类别，不带值），进错误体的 plaintext
    readonly plaintext?: PlaintextFinding[],
    // 凭据写入失败的原因与留在密码库里的条目，进错误体的 reason、vaultItem
    readonly write?: { reason?: CredentialWriteReason; vaultItem?: OrphanVaultItem },
  ) {
    super(message)
  }
}

// 读到之后被别的请求改过：错误体带上 reason: version，界面据此提示重新读取
// 按天计数时 PostgreSQL 的时区库里没有这个名字：路由回 400 并带上 code，界面据此退回 UTC
export class UnknownTimeZoneError extends MemoryError {
  constructor(tz: string) {
    super(400, `无法识别时区 ${tz}`)
  }
}

export const versionConflict = (message: string) =>
  new MemoryError(409, message, undefined, { reason: 'version' })
