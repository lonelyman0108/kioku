import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, type Ref } from 'vue'

import { api } from '../api/endpoints'
import { destinationProblem, itemsAvailable, newCredentialStore } from '../vault'
import { fetchVaultItems } from '../vaultQueries'

// 新建的凭据写到哪里：新建凭据、转存与保存前处理共用。
export function useNewCredentialStore(circleId: Ref<string>, enabled: Ref<boolean>) {
  const queryClient = useQueryClient()
  const connections = useQuery({
    queryKey: computed(() => ['vault-connections', circleId.value] as const),
    queryFn: ({ queryKey: [, cid] }) => api.vaultConnections(cid),
    enabled,
  })
  const store = computed(() => newCredentialStore(connections.data.value?.items))
  const destination = computed(() =>
    store.value?.kind === 'vault' ? store.value.connection : null,
  )
  const items = useQuery({
    queryKey: computed(
      () => ['vault-items', circleId.value, destination.value?.id ?? null] as const,
    ),
    queryFn: ({ queryKey: [, cid, id] }) => fetchVaultItems(queryClient, cid, id!),
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
