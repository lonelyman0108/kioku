import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { destinationProblem, itemsAvailable, newCredentialStore } from '../vault'
import { fetchVaultItems } from '../vaultQueries'

// 新建的凭据写到哪里：新建凭据、转存与保存前处理共用。
// store：设了去处写进那个集合，没有时由 Kioku 托管；连接列表没读到时为 null。
// issue：去处眼下用不了的原因（连接不可用，或者集合只读、不见了），和连接面板同一个判断，集合取自同一个条目列表查询。
// failed：连接列表读取失败，不知道值会写到哪里，新建要拦下
export function useNewCredentialStore(spaceId: Ref<string>, enabled: Ref<boolean>) {
  const queryClient = useQueryClient()
  const connections = useQuery({
    queryKey: computed(() => ['vault-connections', spaceId.value] as const),
    queryFn: ({ queryKey: [, sid] }) => api.vaultConnections(sid),
    enabled,
  })
  const store = computed(() => newCredentialStore(connections.data.value?.items))
  const destination = computed(() =>
    store.value?.kind === 'vault' ? store.value.connection : null,
  )
  const items = useQuery({
    queryKey: computed(
      () => ['vault-items', spaceId.value, destination.value?.id ?? null] as const,
    ),
    queryFn: ({ queryKey: [, sid, id] }) => fetchVaultItems(queryClient, sid, id!),
    enabled: computed(
      () => enabled.value && !!destination.value && itemsAvailable(destination.value),
    ),
  })
  const issue = computed(() =>
    destination.value ? destinationProblem(destination.value, items.data.value?.collections) : null,
  )
  const failed = computed(() => connections.isError.value && !connections.data.value)
  return { store, issue, failed }
}
