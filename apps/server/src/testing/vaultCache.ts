import type { VaultClient } from '../credential/bitwarden/types'
import { VaultConnections } from '../credential/vault'
import type { Db } from '../db/client'

// 测试用：这个客户端的会话缓存里有没有这个连接的会话。缓存是 VaultConnections 的私有字段，
// 生产代码不需要从外面看它，所以只在这里绕过类型去读
export function hasCachedSession(client: VaultClient, connectionId: string): boolean {
  const connections = new VaultConnections({
    db: null as unknown as Db,
    spaceId: '',
    ownerAccountId: '',
    masterKey: null,
    client,
  })
  return (connections as unknown as { cache: Map<string, unknown> }).cache.has(connectionId)
}
