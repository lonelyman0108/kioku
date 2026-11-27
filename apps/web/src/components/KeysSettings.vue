<script setup lang="ts">
import type { ApiKeyView, IssuedApiKeyResponse } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import { envDisplayName } from '../labels'
import { formatRelative, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import IssueKeyModal from './IssueKeyModal.vue'
import RuntimeLabel from './RuntimeLabel.vue'
import EmptyState from './ui/EmptyState.vue'
import NoteLine from './ui/NoteLine.vue'
import ReadFailureNote from './ui/ReadFailureNote.vue'
import SectionHeading from './ui/SectionHeading.vue'

const toast = useToast()
const queryClient = useQueryClient()
const copy = useCopy()

const origin = computed(() => window.location.origin)
const mcpUrl = computed(() => `${origin.value}/v1/mcp`)
const loginCmd = computed(() => `kioku login ${origin.value}`)

const keysQuery = useQuery({
  queryKey: ['api-keys'] as const,
  queryFn: () => api.keys(),
})

const activeKeys = computed(() => (keysQuery.data.value?.items ?? []).filter((k) => !k.revokedAt))
const revokedKeys = computed(() => (keysQuery.data.value?.items ?? []).filter((k) => k.revokedAt))

const modalOpen = ref(false)
const editing = ref<ApiKeyView | null>(null)

function openIssue() {
  editing.value = null
  modalOpen.value = true
}

function openEdit(item: ApiKeyView) {
  editing.value = item
  modalOpen.value = true
}

function onSaved() {
  void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
  void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
}

// 轮换访问密钥：弹出一次性明文窗口（不可误关）
const rotatingId = ref<string | null>(null)
const rotatedSecret = ref<IssuedApiKeyResponse | null>(null)

async function rotate(item: ApiKeyView) {
  if (rotatingId.value) return
  rotatingId.value = item.id
  try {
    rotatedSecret.value = await api.rotateKey(item.id, {})
    void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '轮换失败', color: 'error' })
  } finally {
    rotatingId.value = null
  }
}

// 吊销访问密钥
const revoking = ref<ApiKeyView | null>(null)
const revokeBusy = ref(false)
const revokeError = ref<string | null>(null)

async function confirmRevoke() {
  const target = revoking.value
  if (!target || revokeBusy.value) return
  revokeBusy.value = true
  revokeError.value = null
  try {
    await api.deleteKey(target.id)
    revoking.value = null
    toast.add({ title: `已吊销访问密钥「${target.name}」`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
  } catch (err) {
    revokeError.value = err instanceof ApiError ? err.message : '吊销失败'
  } finally {
    revokeBusy.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <section class="space-y-3">
      <SectionHeading title="快捷接入" :level="2" />
      <div class="connect-grid">
        <div class="connect-card">
          <span class="connect-label">MCP 端点</span>
          <div class="connect-value">
            <code class="font-mono text-xs">{{ mcpUrl }}</code>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.copy"
              @click="copy(mcpUrl, '已复制 MCP 地址')"
            >
              复制
            </UButton>
          </div>
        </div>
        <div class="connect-card">
          <span class="connect-label">命令行一键登录</span>
          <div class="connect-value">
            <code class="font-mono text-xs">{{ loginCmd }}</code>
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              :icon="icons.copy"
              @click="copy(loginCmd, '已复制登录命令')"
            >
              复制
            </UButton>
          </div>
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <SectionHeading title="访问密钥" :level="2">
        <template #actions>
          <UButton size="sm" :icon="icons.add" @click="openIssue">签发访问密钥</UButton>
        </template>
      </SectionHeading>

      <ReadFailureNote v-if="keysQuery.isError.value" :query="keysQuery" />
      <div v-if="keysQuery.isPending.value" class="space-y-2">
        <USkeleton v-for="n in 3" :key="n" class="h-14 w-full" />
      </div>

      <div v-else-if="activeKeys.length" class="table-wrap">
        <table class="keys-table">
          <thead>
            <tr>
              <th scope="col">名称与客户端</th>
              <th scope="col">前缀</th>
              <th scope="col">终端环境与场域</th>
              <th scope="col">权限</th>
              <th scope="col">最近使用</th>
              <th scope="col" class="actions-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in activeKeys" :key="item.id">
              <td>
                <p class="font-medium">{{ item.name }}</p>
                <p class="mt-0.5 text-xs text-muted">
                  <RuntimeLabel :family="item.runtimeFamily" :size="13" />
                </p>
              </td>
              <td>
                <code class="font-mono text-xs">{{ item.prefix }}</code>
              </td>
              <td>
                <div class="tag-list">
                  <span v-for="e in item.envs" :key="`e:${e}`" class="tag">
                    {{ envDisplayName(e) }}
                  </span>
                  <span v-if="item.allowedRealms === null" class="text-xs text-muted"
                    >全部场域</span
                  >
                  <span v-else-if="!item.allowedRealms.length" class="tag">仅通用</span>
                  <span v-for="r in item.allowedRealms ?? []" :key="`r:${r}`" class="tag">
                    场域:{{ r }}
                  </span>
                  <span v-for="f in item.focusRealms ?? []" :key="`f:${f}`" class="tag tag-focus">
                    聚焦:{{ f }}
                  </span>
                </div>
              </td>
              <td>
                <div class="tag-list">
                  <span class="tag">{{ item.canWrite ? '读写' : '只读' }}</span>
                  <span v-if="item.canResolveCredentials" class="tag">解析凭据</span>
                </div>
              </td>
              <td>
                <time
                  v-if="item.lastUsedAt"
                  class="text-xs text-muted whitespace-nowrap"
                  :datetime="item.lastUsedAt"
                  :title="formatTime(item.lastUsedAt)"
                >
                  {{ formatRelative(item.lastUsedAt) }}
                </time>
                <span v-else class="text-xs text-muted">尚未使用</span>
              </td>
              <td>
                <div class="row-actions">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.edit"
                    @click="openEdit(item)"
                  >
                    编辑
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="outline"
                    :icon="icons.rotate"
                    :loading="rotatingId === item.id"
                    @click="rotate(item)"
                  >
                    轮换
                  </UButton>
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    :icon="icons.revoked"
                    @click="((revoking = item), (revokeError = null))"
                  >
                    吊销
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <EmptyState
        v-else-if="!keysQuery.isError.value"
        title="暂无访问密钥"
        description="签发访问密钥或通过命令行发起浏览器授权，以接入编码工具。"
      >
        <template #actions>
          <UButton size="sm" @click="openIssue">签发访问密钥</UButton>
        </template>
      </EmptyState>

      <details v-if="revokedKeys.length" class="pt-3">
        <summary class="cursor-pointer text-xs text-muted">
          已吊销的访问密钥（{{ revokedKeys.length }} 个）
        </summary>
        <ul class="mt-2 divide-y divide-default border-t border-default text-xs text-muted">
          <li
            v-for="item in revokedKeys"
            :key="item.id"
            class="flex flex-wrap items-center justify-between gap-2 py-2"
          >
            <span
              >{{ item.name }}（<code class="font-mono">{{ item.prefix }}</code
              >）</span
            >
            <time v-if="item.revokedAt" :datetime="item.revokedAt">
              吊销于 {{ formatTime(item.revokedAt) }}
            </time>
          </li>
        </ul>
      </details>
    </section>

    <IssueKeyModal v-model:open="modalOpen" :editing="editing" @saved="onSaved" />

    <UModal
      :open="rotatedSecret !== null"
      title="新访问密钥已生成"
      :dismissible="false"
      :close="false"
      :ui="{ content: 'max-w-lg sm:max-w-lg' }"
    >
      <template #body>
        <div v-if="rotatedSecret" class="space-y-4">
          <NoteLine tone="warning">
            旧访问密钥已吊销，新明文密钥仅显示这一次，请立即复制并更新客户端配置。
          </NoteLine>
          <div class="secret-row">
            <code class="secret-code">{{ rotatedSecret.key }}</code>
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              :icon="icons.copy"
              @click="copy(rotatedSecret.key, '已复制新访问密钥')"
            >
              复制
            </UButton>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end">
          <UButton @click="rotatedSecret = null">我已保存</UButton>
        </div>
      </template>
    </UModal>

    <ConsequenceModal
      :open="revoking !== null"
      :title="`吊销访问密钥「${revoking?.name ?? ''}」？`"
      :consequences="[
        '使用该访问密钥的终端与插件将立即失去访问权限。',
        '吊销后不可恢复，如需继续接入请重新签发。',
      ]"
      action="确认吊销"
      :busy="revokeBusy"
      :error="revokeError"
      @confirm="confirmRevoke"
      @close="revoking = null"
    />
  </div>
</template>

<style scoped>
.connect-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.connect-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.connect-label {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.connect-value {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.connect-value code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.table-wrap {
  overflow-x: auto;
}
.keys-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.keys-table th {
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid var(--ui-border-accented);
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.keys-table th.actions-col {
  padding-right: 0;
  text-align: right;
}
.keys-table td {
  padding: 10px 12px 10px 0;
  border-bottom: 1px solid var(--ui-border);
  vertical-align: top;
}
.keys-table td:last-child {
  padding-right: 0;
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.5;
  white-space: nowrap;
}
.tag-focus {
  border-style: dashed;
  color: var(--ui-text-muted);
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.secret-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.secret-code {
  min-width: 0;
  flex: 1;
  font-family: var(--font-mono);
  font-size: 13px;
  word-break: break-all;
}
@media (max-width: 767.98px) {
  .connect-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
