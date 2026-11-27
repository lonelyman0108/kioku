<script setup lang="ts">
import type { CredentialMeta } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import ConsequenceModal from '../components/ConsequenceModal.vue'
import CredentialModal from '../components/CredentialModal.vue'
import Hint from '../components/Hint.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import NoteLine from '../components/ui/NoteLine.vue'
import PageHead from '../components/ui/PageHead.vue'
import ReadFailureNote from '../components/ui/ReadFailureNote.vue'
import { useCopy } from '../composables/useCopy'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { placeholderOf } from '../placeholders'
import { formatRelative, formatTime } from '../time'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const copy = useCopy()
const { me } = useSession()

const hasMasterKey = computed(() => me.data.value?.hasMasterKey ?? true)
const highlightSlug = computed(() => (typeof route.query.id === 'string' ? route.query.id : null))

const credentialsQuery = useQuery({
  queryKey: ['credentials'] as const,
  queryFn: () => api.credentials(),
})
const items = computed(() => credentialsQuery.data.value?.items ?? [])

const formOpen = ref(false)
const editing = ref<CredentialMeta | null>(null)

function openCreate() {
  editing.value = null
  formOpen.value = true
}

function openEdit(item: CredentialMeta) {
  editing.value = item
  formOpen.value = true
}

function onSaved(saved: CredentialMeta) {
  toast.add({ title: `已保存凭据 ${saved.slug}`, color: 'success' })
  void queryClient.invalidateQueries({ queryKey: ['credentials'] })
}

// 显式查看明文值与原地轮换：明文只保存在局部 ref，关闭弹窗立刻清空，绝不进入查询缓存
const revealTarget = ref<CredentialMeta | null>(null)
const revealedValue = ref<string | null>(null)
const revealing = ref(false)
const revealError = ref<string | null>(null)
const rotateValue = ref('')
const rotating = ref(false)

async function openReveal(item: CredentialMeta) {
  revealTarget.value = item
  revealedValue.value = null
  revealError.value = null
  rotateValue.value = ''
  revealing.value = true
  try {
    const res = await api.revealCredential(item.id)
    if (revealTarget.value?.id === item.id) revealedValue.value = res.value
  } catch (err) {
    revealError.value = err instanceof ApiError ? err.message : '读取凭据值失败'
  } finally {
    revealing.value = false
  }
}

function closeReveal() {
  if (rotating.value) return
  revealTarget.value = null
  revealedValue.value = null
  revealError.value = null
  rotateValue.value = ''
}

async function rotateSecret() {
  const target = revealTarget.value
  if (!target || !rotateValue.value || rotating.value) return
  rotating.value = true
  revealError.value = null
  try {
    await api.updateCredential(target.id, { value: rotateValue.value })
    revealedValue.value = rotateValue.value
    rotateValue.value = ''
    toast.add({ title: `已更新凭据 ${target.slug} 的值`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['credentials'] })
  } catch (err) {
    revealError.value = err instanceof ApiError ? err.message : '更新凭据值失败'
  } finally {
    rotating.value = false
  }
}

const deleting = ref<CredentialMeta | null>(null)
const deleteBusy = ref(false)
const deleteError = ref<string | null>(null)

async function confirmDelete() {
  const target = deleting.value
  if (!target || deleteBusy.value) return
  deleteBusy.value = true
  deleteError.value = null
  try {
    await api.deleteCredential(target.id)
    deleting.value = null
    toast.add({ title: `已删除凭据 ${target.slug}`, color: 'success' })
    void queryClient.invalidateQueries({ queryKey: ['credentials'] })
  } catch (err) {
    deleteError.value = err instanceof ApiError ? err.message : '删除失败'
  } finally {
    deleteBusy.value = false
  }
}

watch(highlightSlug, (slug) => {
  if (!slug) return
  const matched = items.value.find((item) => item.slug === slug)
  if (matched) void router.replace({ query: { id: matched.slug } })
})
</script>

<template>
  <div class="credentials-page">
    <div class="credentials-shell">
      <PageHead title="凭据">
        <template #note>
          密码与令牌加密托管在 Kioku，记忆正文只写占位符，例如
          <code v-pre class="font-mono text-[13px]">{{cred:prod-db}}</code
          >。
          <Hint> Agent 无法读取明文值；执行命令时通过 kioku run 在本地进程中注入环境变量。 </Hint>
        </template>
        <template #actions>
          <UButton :icon="icons.add" size="sm" :disabled="!hasMasterKey" @click="openCreate">
            新建凭据
          </UButton>
        </template>
      </PageHead>

      <div class="credentials-body">
        <NoteLine v-if="!hasMasterKey" tone="warning">
          未配置主密钥 KIOKU_MASTER_KEY，无法创建或读取加密凭据。
        </NoteLine>

        <ReadFailureNote v-if="credentialsQuery.isError.value" :query="credentialsQuery" />

        <div v-if="credentialsQuery.isPending.value" class="space-y-2">
          <USkeleton v-for="n in 4" :key="n" class="h-14 w-full" />
        </div>

        <div v-else-if="items.length" class="table-wrap">
          <table class="cred-table">
            <thead>
              <tr>
                <th scope="col">标识与占位符</th>
                <th scope="col">名称与说明</th>
                <th scope="col">允许场域</th>
                <th scope="col">更新时间</th>
                <th scope="col" class="actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in items"
                :key="item.id"
                :class="{ highlighted: item.slug === highlightSlug }"
              >
                <td>
                  <div class="slug-cell">
                    <code class="font-mono text-sm font-medium">{{ item.slug }}</code>
                    <UButton
                      :icon="icons.copy"
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      :aria-label="`复制占位符 ${item.slug}`"
                      @click="copy(placeholderOf(item.slug), '已复制占位符')"
                    >
                      占位符
                    </UButton>
                  </div>
                </td>
                <td>
                  <p class="font-medium">{{ item.label }}</p>
                  <p v-if="item.description" class="text-xs text-muted">{{ item.description }}</p>
                </td>
                <td>
                  <span v-if="item.allowedRealms === null" class="text-xs text-muted">不限</span>
                  <span v-else-if="!item.allowedRealms.length" class="text-xs text-muted">
                    仅无场域
                  </span>
                  <div v-else class="flex flex-wrap gap-1">
                    <span v-for="r in item.allowedRealms" :key="r" class="realm-tag">{{ r }}</span>
                  </div>
                </td>
                <td>
                  <time
                    class="text-xs text-muted whitespace-nowrap"
                    :datetime="item.updatedAt"
                    :title="formatTime(item.updatedAt)"
                  >
                    {{ formatRelative(item.updatedAt) }}
                  </time>
                </td>
                <td>
                  <div class="row-actions">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :icon="icons.reveal"
                      :disabled="!hasMasterKey"
                      @click="openReveal(item)"
                    >
                      查看值
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="outline"
                      :icon="icons.edit"
                      :disabled="!hasMasterKey"
                      @click="openEdit(item)"
                    >
                      编辑
                    </UButton>
                    <UButton
                      size="xs"
                      color="error"
                      variant="ghost"
                      :icon="icons.remove"
                      @click="((deleting = item), (deleteError = null))"
                    >
                      删除
                    </UButton>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <EmptyState
          v-else-if="!credentialsQuery.isError.value"
          title="暂无凭据"
          description="新建凭据后，可在记忆正文里插入占位符，避免明文密码进入上下文。"
        >
          <template v-if="hasMasterKey" #actions>
            <UButton size="sm" @click="openCreate">新建凭据</UButton>
          </template>
        </EmptyState>
      </div>
    </div>

    <CredentialModal v-model:open="formOpen" :editing="editing" @saved="onSaved" />

    <UModal
      :open="revealTarget !== null"
      :title="revealTarget ? `凭据 ${revealTarget.slug}` : '凭据值'"
      :dismissible="!rotating"
      :ui="{ content: 'max-w-xl sm:max-w-xl' }"
      @update:open="(v) => !v && closeReveal()"
    >
      <template #body>
        <div class="space-y-4">
          <div class="space-y-1.5">
            <p class="text-xs font-medium text-muted">当前明文值</p>
            <USkeleton v-if="revealing" class="h-12 w-full" />
            <div v-else-if="revealedValue !== null" class="secret-box">
              <pre class="secret-text">{{ revealedValue }}</pre>
              <UButton
                size="xs"
                color="neutral"
                variant="outline"
                :icon="icons.copy"
                @click="copy(revealedValue, '已复制凭据值')"
              >
                复制
              </UButton>
            </div>
            <p v-if="revealError" class="text-sm text-error" role="alert">{{ revealError }}</p>
          </div>

          <div class="space-y-2 border-t border-default pt-4">
            <UFormField label="更换凭据值">
              <UTextarea
                v-model="rotateValue"
                :rows="3"
                placeholder="输入新值以立即覆盖"
                class="w-full font-mono"
                autocomplete="off"
                spellcheck="false"
              />
            </UFormField>
            <div class="flex justify-end">
              <UButton size="sm" :loading="rotating" :disabled="!rotateValue" @click="rotateSecret">
                更新凭据值
              </UButton>
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end">
          <UButton color="neutral" variant="outline" :disabled="rotating" @click="closeReveal">
            关闭
          </UButton>
        </div>
      </template>
    </UModal>

    <ConsequenceModal
      :open="deleting !== null"
      :title="`删除凭据 ${deleting?.slug ?? ''}？`"
      :consequences="[
        '加密保存的凭据值将被永久删除，无法恢复。',
        '引用该占位符的记忆与命令行调用将无法再解析到值。',
      ]"
      action="确认删除"
      :busy="deleteBusy"
      :error="deleteError"
      @confirm="confirmDelete"
      @close="deleting = null"
    />
  </div>
</template>

<style scoped>
.credentials-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.credentials-shell {
  width: 100%;
  max-width: 76rem;
  margin-inline: auto;
}
.credentials-body {
  padding: 0 32px 48px;
}
.table-wrap {
  overflow-x: auto;
  border-top: 1px solid var(--ui-rule);
}
.cred-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.cred-table th {
  padding: 8px 12px 8px 0;
  border-bottom: 1px solid var(--ui-border-accented);
  text-align: left;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.cred-table th.actions-col {
  padding-right: 0;
  text-align: right;
}
.cred-table td {
  padding: 10px 12px 10px 0;
  border-bottom: 1px solid var(--ui-border);
  vertical-align: top;
}
.cred-table td:last-child {
  padding-right: 0;
}
.cred-table tr.highlighted {
  background: var(--ui-bg-elevated);
}
.slug-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.realm-tag {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.5;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}
.secret-box {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-rule);
  background: var(--ui-bg-muted);
}
.secret-text {
  min-width: 0;
  flex: 1;
  max-height: 14rem;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
@media (max-width: 1023.98px) {
  .credentials-body {
    padding: 0 16px 36px;
  }
}
</style>
