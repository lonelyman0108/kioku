<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { VaultConnection, VaultItemSummary } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { formatRelative, formatTime } from '../time'
import {
  collectionNames,
  connectionStatusText,
  disabledAdvice,
  disconnectNotice,
  itemFieldLabel,
  itemsAvailable,
  vaultErrorLabels,
  vaultItemTypeLabels,
} from '../vault'
import ReadFailureNote from './strata/ReadFailureNote.vue'

// 一个密码库连接：状态与操作，以及它读得到的条目（名称、类型、字段与所在集合，不含值）
const props = defineProps<{ spaceId: string; connection: VaultConnection; canManage: boolean }>()
const emit = defineEmits<{
  reconnect: []
  'open-credential': [id: string]
  'name-item': [item: VaultItemSummary]
}>()
const toast = useToast()
const queryClient = useQueryClient()

const c = computed(() => props.connection)
const items = useQuery({
  queryKey: computed(() => ['vault-items', props.spaceId, c.value.id] as const),
  queryFn: ({ queryKey: [, sid, id] }) => api.vaultItems(sid, id),
  enabled: computed(() => props.canManage && itemsAvailable(c.value)),
})

// 状态变了，条目与指向它的凭据也跟着变
async function refresh(sid: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['vault-connections', sid] }),
    queryClient.invalidateQueries({ queryKey: ['vault-items', sid] }),
    queryClient.invalidateQueries({ queryKey: ['credentials', sid] }),
  ])
}

const busy = ref(false)
async function check() {
  if (busy.value) return
  const sid = props.spaceId
  busy.value = true
  try {
    const next = await api.checkVault(sid, c.value.id)
    toast.add({
      title: next.status === 'ok' ? '连接可用' : connectionStatusText(next),
      color: next.status === 'ok' ? 'success' : 'warning',
    })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '检查失败', color: 'error' })
  } finally {
    busy.value = false
    await refresh(sid)
  }
}

const confirmingDisconnect = ref(false)
async function disconnect() {
  if (busy.value) return
  const sid = props.spaceId
  busy.value = true
  try {
    await api.disconnectVault(sid, c.value.id)
    confirmingDisconnect.value = false
    toast.add({ title: '已断开密码库', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '断开失败', color: 'error' })
  } finally {
    busy.value = false
    await refresh(sid)
  }
}

const itemRows = computed(() => {
  const list = items.data.value
  if (!list) return []
  return list.items.map((item) => ({
    item,
    collections: collectionNames(item, list).join('、'),
    fields: item.fields.map(itemFieldLabel).join('、'),
  }))
})
</script>

<template>
  <section class="vault-connection">
    <header class="conn-head">
      <div class="conn-title">
        <span class="conn-email">{{ c.email }}</span>
        <code class="conn-server">{{ c.serverUrl }}</code>
      </div>
      <div v-if="canManage" class="conn-actions">
        <UButton
          v-if="c.status !== 'ok'"
          size="xs"
          color="primary"
          variant="outline"
          @click="emit('reconnect')"
        >
          重新登录
        </UButton>
        <UButton
          v-if="c.status !== 'disconnected'"
          size="xs"
          color="neutral"
          variant="outline"
          :loading="busy"
          @click="check"
        >
          重新检查
        </UButton>
        <UButton
          v-if="c.status !== 'disconnected'"
          size="xs"
          color="error"
          variant="ghost"
          @click="confirmingDisconnect = true"
        >
          断开
        </UButton>
      </div>
    </header>
    <p class="conn-status">
      <span class="status-name" :class="{ dim: c.status === 'disconnected' }">
        {{ connectionStatusText(c) }}
      </span>
      <span> {{ c.credentialCount }} 条凭据 </span>
      <span v-if="c.lastCheckedAt" :title="formatTime(c.lastCheckedAt)">
        最近同步 {{ formatRelative(c.lastCheckedAt) }}
      </span>
      <span v-if="c.disconnectedAt" :title="formatTime(c.disconnectedAt)">
        断开于 {{ formatRelative(c.disconnectedAt) }}
      </span>
    </p>
    <p v-if="c.lastError" class="conn-error">
      最近一次错误：{{ vaultErrorLabels[c.lastError.kind] }}，
      <time :datetime="c.lastError.at" :title="formatTime(c.lastError.at)">
        {{ formatRelative(c.lastError.at) }}
      </time>
    </p>
    <p v-if="c.status === 'disabled' && c.disabledReason" class="conn-error">
      {{ disabledAdvice[c.disabledReason] }}
    </p>
    <p v-else-if="c.status === 'reauth_required'" class="conn-error">
      登录已失效（例如主密码已修改），重新登录后恢复。
    </p>

    <template v-if="canManage && itemsAvailable(c)">
      <div v-if="items.isError.value" class="pt-2">
        <ReadFailureNote :query="items" size="xs" />
      </div>
      <div v-if="items.isPending.value" class="space-y-2 pt-3">
        <USkeleton v-for="n in 3" :key="n" class="h-9 w-full" />
      </div>
      <template v-else-if="itemRows.length">
        <div class="ledger-head item-grid" aria-hidden="true">
          <span>条目</span>
          <span>类型</span>
          <span>字段</span>
          <span>集合</span>
          <span>标识</span>
        </div>
        <ul>
          <li v-for="row in itemRows" :key="row.item.id" class="item-row item-grid">
            <span class="item-name">{{ row.item.name }}</span>
            <span class="row-muted" data-label="类型">{{
              vaultItemTypeLabels[row.item.type]
            }}</span>
            <span class="row-muted" data-label="字段">{{ row.fields }}</span>
            <span class="row-muted" data-label="集合">{{ row.collections }}</span>
            <span class="item-credential">
              <UButton
                v-if="row.item.credential"
                class="font-mono"
                size="xs"
                color="neutral"
                variant="link"
                :aria-label="`查看凭据 ${row.item.credential.identifier}`"
                @click="emit('open-credential', row.item.credential.id)"
              >
                {{ row.item.credential.identifier }}
              </UButton>
              <UButton
                v-else
                size="xs"
                color="primary"
                variant="outline"
                @click="emit('name-item', row.item)"
              >
                起标识
              </UButton>
            </span>
          </li>
        </ul>
      </template>
      <p v-else-if="items.data.value" class="empty">暂无条目</p>
    </template>

    <UModal v-model:open="confirmingDisconnect" :title="`断开密码库 ${c.email}？`">
      <template #body>
        <p class="text-sm">{{ disconnectNotice(c) }}</p>
        <p class="mt-2 text-sm text-muted">
          要让已发出的令牌立即失效，请在密码库的设备列表中注销 Kioku。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="confirmingDisconnect = false">
            取消
          </UButton>
          <UButton color="error" :loading="busy" @click="disconnect">断开</UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
.vault-connection {
  padding: 12px 0 18px;
  border-bottom: 1px solid var(--strata-rule);
}
.conn-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.conn-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  min-width: 0;
}
.conn-email {
  font-weight: 600;
  overflow-wrap: anywhere;
}
.conn-server {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.conn-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}
.conn-status {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 14px;
  margin-top: 4px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.status-name {
  font-weight: 500;
  color: var(--ui-text);
}
.status-name.dim {
  color: var(--ui-text-muted);
}
.conn-error {
  margin-top: 2px;
  line-height: 1.6;
  color: var(--ui-text-muted);
}
.item-grid {
  display: grid;
  grid-template-columns:
    minmax(9rem, 1.4fr) 5rem minmax(7rem, 1.2fr) minmax(6rem, 1fr)
    minmax(6rem, 0.9fr);
  column-gap: 14px;
}
.ledger-head {
  margin-top: 10px;
  padding: 6px 0;
  border-bottom: 1px solid var(--strata-rule);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.item-row {
  align-items: center;
  padding: 6px 0 5px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.item-name {
  min-width: 0;
  font-weight: 500;
}
.item-credential {
  justify-self: start;
}
.row-muted {
  color: var(--ui-text-muted);
}
.empty {
  padding: 12px 0 0;
  color: var(--ui-text-muted);
}
[data-label]::before {
  content: attr(data-label) ' ';
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 1023.98px) {
  .ledger-head {
    display: none;
  }
  .item-grid {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1px 12px;
  }
  .item-grid > * {
    grid-column: 1;
  }
  .item-grid .item-credential {
    grid-row: 1;
    grid-column: 2;
  }
  [data-label]::before {
    position: static;
    width: auto;
    height: auto;
    margin-right: 6px;
    overflow: visible;
    clip-path: none;
    font-size: 13px;
    color: var(--ui-text-muted);
  }
}
</style>
