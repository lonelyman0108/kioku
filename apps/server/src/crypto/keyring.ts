import { createHash } from 'node:crypto'

// 主密钥：加密只用当前的；轮换期间还配着旧的那把，只用来解开还没换成新密钥包装的记录。
// 只有一把时（测试、命令行工具）直接给 Buffer
export interface Keyring {
  current: Buffer
  previous: Buffer | null
}
export type MasterKey = Buffer | Keyring

export const keyringOf = (key: MasterKey): Keyring =>
  Buffer.isBuffer(key) ? { current: key, previous: null } : key

// 主密钥的标识，记在包装好的数据密钥旁边：轮换时按它找出还是旧密钥包装的记录。是哈希，推不出密钥本身
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update('kioku-master-key-id\0').update(key).digest('hex').slice(0, 16)
}

// 加密用的主密钥与它的标识
export function encryptionKey(key: MasterKey): { key: Buffer; id: string } {
  const { current } = keyringOf(key)
  return { key: current, id: keyIdOf(current) }
}

// 按记下的标识选解密用的主密钥。没记标识的是加上标识之前写下的，启动时会补上，补之前按当前的试
export function decryptionKey(key: MasterKey, id: string | null | undefined): Buffer {
  const { current, previous } = keyringOf(key)
  if (!id || id === keyIdOf(current)) return current
  if (previous && id === keyIdOf(previous)) return previous
  throw new Error(`这条记录是用另一把主密钥（标识 ${id}）加密的，现在配置的主密钥解不开`)
}
