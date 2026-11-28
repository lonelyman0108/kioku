<script setup lang="ts">
import { normalizeSlugList, type ApiKeyView, type IssuedApiKeyResponse } from '@kioku/contracts'
import { useToast } from '@nuxt/ui/composables'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { useCopy } from '../composables/useCopy'
import { icons } from '../icons'
import {
  buildKeyFilterOptions,
  createDefaultKeyFilter,
  filterActiveKeys,
  hasActiveKeyFilter,
  type KeyFilterState,
} from '../keyFilters'
import { envDisplayName } from '../labels'
import { formatRelative, formatTime } from '../time'
import ConsequenceModal from './ConsequenceModal.vue'
import IssueKeyModal from './IssueKeyModal.vue'
import RuntimeLabel from './RuntimeLabel.vue'
import SegmentedChoice from './SegmentedChoice.vue'
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
const credentialKeyCount = computed(
  () => activeKeys.value.filter((k) => k.canResolveCredentials).length,
)

const knownRealms = computed(() => {
  const realms: string[] = []
  for (const item of activeKeys.value) {
    if (item.allowedRealms) realms.push(...item.allowedRealms)
    if (item.focusRealms) realms.push(...item.focusRealms)
  }
  return normalizeSlugList(realms)
})

// 多维前端即时筛选状态
const filter = reactive<KeyFilterState>(createDefaultKeyFilter())
const filterOptions = computed(() => buildKeyFilterOptions(activeKeys.value))
const filterActive = computed(() => hasActiveKeyFilter(filter))
const filteredKeys = computed(() => filterActiveKeys(activeKeys.value, filter))

function resetFilter() {
  Object.assign(filter, createDefaultKeyFilter())
}

// 右侧接入辅助轨：客户端配置示例折叠与切换
const configExpanded = ref(false)
const configTab = ref<'claude' | 'codex'>('claude')
const configTabItems = [
  { value: 'claude' as const, label: 'Claude Code' },
  { value: 'codex' as const, label: 'Codex' },
]
const configSnippet = computed(() => {
  if (configTab.value === 'claude') {
    return `claude mcp add --transport http kioku ${mcpUrl.value} \\\n  --header "Authorization: Bearer <访问密钥>"`
  }
  return `[mcp_servers.kioku]\nurl = "${mcpUrl.value}"\nbearer_token_env_var = "KIOKU_ACCESS_KEY"`
})

// 签发 / 编辑 460px 右滑抽屉
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

// 轮换访问密钥：须先经不可逆后果弹窗确认，再生成一次性明文窗口（不可误关）
const rotatingTarget = ref<ApiKeyView | null>(null)
const rotateBusy = ref(false)
const rotateError = ref<string | null>(null)
const rotatedSecret = ref<IssuedApiKeyResponse | null>(null)

function requestRotate(item: ApiKeyView) {
  rotatingTarget.value = item
  rotateError.value = null
}

async function confirmRotate() {
  const target = rotatingTarget.value
  if (!target || rotateBusy.value) return
  rotateBusy.value = true
  rotateError.value = null
  try {
    const res = await api.rotateKey(target.id, {})
    rotatingTarget.value = null
    if (editing.value?.id === target.id) {
      modalOpen.value = false
      editing.value = null
    }
    rotatedSecret.value = res
    void queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    void queryClient.invalidateQueries({ queryKey: ['boot-preview'] })
  } catch (err) {
    rotateError.value = err instanceof ApiError ? err.message : '轮换失败'
  } finally {
    rotateBusy.value = false
  }
}

// 吊销访问密钥
const revoking = ref<ApiKeyView | null>(null)
const revokeBusy = ref(false)
const revokeError = ref<string | null>(null)

function requestRevoke(item: ApiKeyView) {
  revoking.value = item
  revokeError.value = null
}

async function confirmRevoke() {
  const target = revoking.value
  if (!target || revokeBusy.value) return
  revokeBusy.value = true
  revokeError.value = null
  try {
    await api.deleteKey(target.id)
    revoking.value = null
    if (editing.value?.id === target.id) {
      modalOpen.value = false
      editing.value = null
    }
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
  <article class="editor-pane">
    <header class="editor-head">
      <div class="head-main">
        <div class="head-identity">
          <div class="head-title-row">
            <h1>终端与密钥</h1>
          </div>
          <div class="head-status-line">
            <span class="tabular-nums">{{ activeKeys.length }} 个有效访问密钥</span>
            <span class="status-sep" aria-hidden="true">·</span>
            <span class="tabular-nums">{{ credentialKeyCount }} 个允许解析凭据</span>
            <template v-if="revokedKeys.length > 0">
              <span class="status-sep" aria-hidden="true">·</span>
              <span class="tabular-nums">{{ revokedKeys.length }} 个已吊销</span>
            </template>
          </div>
        </div>
        <div class="head-actions">
          <UButton
            size="sm"
            :icon="icons.add"
            class="shrink-0 whitespace-nowrap"
            @click="openIssue"
          >
            签发访问密钥
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            :icon="icons.shieldCheck"
            :to="{ name: 'authorize' }"
            class="shrink-0 whitespace-nowrap"
          >
            浏览器授权
          </UButton>
        </div>
      </div>
    </header>

    <div class="editor-scroll">
      <div class="read-layout has-rail">
        <!-- 左侧主区：访问密钥筛选与纸墨清单 -->
        <div class="read-main">
          <section class="paper-section">
            <SectionHeading title="访问密钥" :icon="icons.keys" :level="2">
              <template #hint>
                <span class="section-count tabular-nums">
                  {{
                    filterActive
                      ? `${filteredKeys.length} / ${activeKeys.length}`
                      : activeKeys.length
                  }}
                </span>
              </template>
            </SectionHeading>

            <ReadFailureNote v-if="keysQuery.isError.value" :query="keysQuery" />

            <div v-if="keysQuery.isPending.value" class="space-y-2">
              <USkeleton v-for="n in 3" :key="n" class="h-14 w-full" />
            </div>

            <template v-else-if="activeKeys.length">
              <!-- 多维即时筛选条 -->
              <div class="key-filter-bar" role="search" aria-label="筛选访问密钥">
                <div class="filter-search-wrap">
                  <UInput
                    v-model="filter.q"
                    size="sm"
                    :icon="icons.search"
                    placeholder="搜索名称或前缀…"
                    aria-label="按名称或前缀搜索访问密钥"
                    class="w-full"
                  >
                    <template v-if="filter.q" #trailing>
                      <button
                        type="button"
                        class="filter-clear-x"
                        aria-label="清空搜索词"
                        @click="filter.q = ''"
                      >
                        <UIcon :name="icons.cancel" class="inline-block size-3.5" />
                      </button>
                    </template>
                  </UInput>
                </div>

                <USelect
                  v-model="filter.runtime"
                  :items="filterOptions.runtimes"
                  value-key="value"
                  size="sm"
                  aria-label="按客户端类型筛选"
                  class="filter-select"
                />
                <USelect
                  v-model="filter.env"
                  :items="filterOptions.envs"
                  value-key="value"
                  size="sm"
                  aria-label="按终端环境筛选"
                  class="filter-select"
                />
                <USelect
                  v-model="filter.realm"
                  :items="filterOptions.realms"
                  value-key="value"
                  size="sm"
                  aria-label="按场域边界筛选"
                  class="filter-select"
                />
                <USelect
                  v-model="filter.permission"
                  :items="filterOptions.permissions"
                  value-key="value"
                  size="sm"
                  aria-label="按权限筛选"
                  class="filter-select"
                />
              </div>

              <div v-if="filterActive" class="filter-status-strip">
                <span class="tabular-nums">
                  匹配 {{ filteredKeys.length }} / 共 {{ activeKeys.length }} 个
                </span>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="icons.filterX"
                  class="shrink-0 whitespace-nowrap"
                  @click="resetFilter"
                >
                  清空筛选
                </UButton>
              </div>

              <ul v-if="filteredKeys.length" class="key-ledger-list" aria-label="有效访问密钥列表">
                <li v-for="item in filteredKeys" :key="item.id" class="key-ledger-row">
                  <div class="key-ledger-main">
                    <div class="key-ledger-top">
                      <span class="key-ledger-name">{{ item.name }}</span>
                      <RuntimeLabel :family="item.runtimeFamily" :size="13" class="key-runtime" />
                      <code class="key-prefix font-mono">{{ item.prefix }}</code>
                    </div>

                    <div class="tag-list">
                      <span v-for="e in item.envs" :key="`e:${e}`" class="tag">
                        <UIcon :name="icons.env" class="tag-icon" aria-hidden="true" />
                        <span>{{ envDisplayName(e) }}</span>
                      </span>
                      <span v-if="item.allowedRealms === null" class="tag tag-muted">不限场域</span>
                      <span v-else-if="!item.allowedRealms.length" class="tag">
                        <UIcon :name="icons.lock" class="tag-icon" aria-hidden="true" />
                        <span>仅通用</span>
                      </span>
                      <span v-for="r in item.allowedRealms ?? []" :key="`r:${r}`" class="tag">
                        <UIcon :name="icons.realm" class="tag-icon" aria-hidden="true" />
                        <span>场域:{{ r }}</span>
                      </span>
                      <span
                        v-for="f in item.focusRealms ?? []"
                        :key="`f:${f}`"
                        class="tag tag-focus"
                      >
                        <UIcon :name="icons.focus" class="tag-icon" aria-hidden="true" />
                        <span>聚焦:{{ f }}</span>
                      </span>
                      <span class="tag tag-muted">
                        <UIcon
                          :name="item.canWrite ? icons.edit : icons.reveal"
                          class="tag-icon"
                          aria-hidden="true"
                        />
                        <span>{{ item.canWrite ? '读写' : '只读' }}</span>
                      </span>
                      <span v-if="item.canResolveCredentials" class="tag">
                        <UIcon :name="icons.credentials" class="tag-icon" aria-hidden="true" />
                        <span>解析凭据</span>
                      </span>
                    </div>
                  </div>

                  <div class="key-ledger-aside">
                    <time
                      v-if="item.lastUsedAt"
                      class="key-last-used"
                      :datetime="item.lastUsedAt"
                      :title="formatTime(item.lastUsedAt)"
                    >
                      {{ formatRelative(item.lastUsedAt) }}
                    </time>
                    <span v-else class="key-last-used">尚未使用</span>

                    <div class="row-actions">
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="outline"
                        :icon="icons.edit"
                        class="shrink-0 whitespace-nowrap"
                        @click="openEdit(item)"
                      >
                        编辑
                      </UButton>
                      <UButton
                        size="xs"
                        color="neutral"
                        variant="outline"
                        :icon="icons.rotate"
                        class="shrink-0 whitespace-nowrap"
                        @click="requestRotate(item)"
                      >
                        轮换
                      </UButton>
                      <UButton
                        size="xs"
                        color="error"
                        variant="ghost"
                        :icon="icons.revoked"
                        class="shrink-0 whitespace-nowrap"
                        @click="requestRevoke(item)"
                      >
                        吊销
                      </UButton>
                    </div>
                  </div>
                </li>
              </ul>

              <EmptyState
                v-else
                :icon="icons.filterX"
                title="暂无匹配的访问密钥"
                description="调整筛选条件或清空筛选后查看全部有效访问密钥。"
              >
                <template #actions>
                  <UButton
                    size="sm"
                    color="neutral"
                    variant="outline"
                    :icon="icons.filterX"
                    @click="resetFilter"
                  >
                    清空筛选
                  </UButton>
                </template>
              </EmptyState>
            </template>

            <EmptyState
              v-else-if="!keysQuery.isError.value"
              :icon="icons.keys"
              title="暂无访问密钥"
              description="签发访问密钥或通过命令行发起浏览器授权，以接入编码工具。"
            >
              <template #actions>
                <UButton size="sm" :icon="icons.add" @click="openIssue">签发访问密钥</UButton>
              </template>
            </EmptyState>

            <details v-if="revokedKeys.length" class="revoked-details">
              <summary class="revoked-summary">
                <UIcon :name="icons.chevronRight" class="revoked-chevron" aria-hidden="true" />
                <UIcon :name="icons.revoked" class="revoked-icon" aria-hidden="true" />
                <span>已吊销的访问密钥（{{ revokedKeys.length }} 个）</span>
              </summary>
              <ul class="revoked-list">
                <li v-for="item in revokedKeys" :key="item.id" class="revoked-row">
                  <span>
                    {{ item.name }}（<code class="font-mono">{{ item.prefix }}</code
                    >）
                  </span>
                  <time v-if="item.revokedAt" :datetime="item.revokedAt">
                    吊销于 {{ formatTime(item.revokedAt) }}
                  </time>
                </li>
              </ul>
            </details>
          </section>
        </div>

        <!-- 右侧辅助轨（窄屏自动下沉）：接入地址、浏览器授权与示例 -->
        <aside class="read-rail" aria-label="接入终端">
          <div class="rail-sections">
            <section class="rail-section">
              <h2 class="rail-heading">
                <UIcon :name="icons.plug" class="rail-heading-icon" aria-hidden="true" />
                <span>接入地址</span>
              </h2>

              <div class="rail-code-block">
                <div class="rail-code-head">
                  <span class="rail-code-label">
                    <UIcon :name="icons.globe" class="rail-mini-icon" aria-hidden="true" />
                    <span>MCP 端点</span>
                  </span>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.copy"
                    class="shrink-0 whitespace-nowrap"
                    @click="copy(mcpUrl, '已复制 MCP 地址')"
                  >
                    复制
                  </UButton>
                </div>
                <div class="rail-code-line">
                  <code class="rail-code-val font-mono">{{ mcpUrl }}</code>
                </div>
              </div>

              <div class="rail-code-block">
                <div class="rail-code-head">
                  <span class="rail-code-label">
                    <UIcon :name="icons.terminal" class="rail-mini-icon" aria-hidden="true" />
                    <span>命令行一键登录</span>
                  </span>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.copy"
                    class="shrink-0 whitespace-nowrap"
                    @click="copy(loginCmd, '已复制登录命令')"
                  >
                    复制
                  </UButton>
                </div>
                <div class="rail-code-line">
                  <code class="rail-code-val font-mono">{{ loginCmd }}</code>
                </div>
              </div>
            </section>

            <section class="rail-section">
              <h2 class="rail-heading">
                <UIcon :name="icons.shieldCheck" class="rail-heading-icon" aria-hidden="true" />
                <span>浏览器授权</span>
              </h2>
              <p class="rail-help">
                在终端运行 <code class="font-mono">kioku login</code> 后，输入 8
                位确认码并核对终端信息即可批准接入。
              </p>
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                :icon="icons.shieldCheck"
                :to="{ name: 'authorize' }"
                block
              >
                输入确认码授权
              </UButton>
            </section>

            <section class="rail-disclosure">
              <button
                type="button"
                class="rail-disclosure-toggle"
                :aria-expanded="configExpanded"
                @click="configExpanded = !configExpanded"
              >
                <UIcon
                  :name="configExpanded ? icons.chevronDown : icons.chevronRight"
                  class="rail-disclosure-icon"
                  aria-hidden="true"
                />
                <UIcon :name="icons.terminal" class="rail-disclosure-icon" aria-hidden="true" />
                <span>客户端配置示例</span>
              </button>
              <div v-if="configExpanded" class="rail-disclosure-body">
                <div class="rail-snippet-bar">
                  <SegmentedChoice
                    v-model="configTab"
                    :items="configTabItems"
                    label="客户端配置示例"
                    compact
                  />
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    :icon="icons.copy"
                    class="shrink-0 whitespace-nowrap"
                    @click="copy(configSnippet, '已复制配置示例')"
                  >
                    复制
                  </UButton>
                </div>
                <pre class="rail-pre font-mono">{{ configSnippet }}</pre>
              </div>
            </section>
          </div>
        </aside>
      </div>
    </div>

    <IssueKeyModal
      v-model:open="modalOpen"
      :editing="editing"
      :known-realms="knownRealms"
      @saved="onSaved"
      @request-rotate="requestRotate"
      @request-revoke="requestRevoke"
    />

    <ConsequenceModal
      :open="rotatingTarget !== null"
      :title="`轮换访问密钥「${rotatingTarget?.name ?? ''}」？`"
      :consequences="[
        `旧访问密钥（${rotatingTarget?.prefix ?? ''}）将立即失效，正在使用该密钥的终端将断开连接。`,
        '新访问密钥沿用原有权限范围与允许场域，明文仅在确认后显示一次。',
      ]"
      action="确认轮换"
      :action-icon="icons.rotate"
      :busy="rotateBusy"
      :error="rotateError"
      @confirm="confirmRotate"
      @close="rotatingTarget = null"
    />

    <!-- 轮换后一次性明文窗口禁止误关，只能点确认关闭 -->
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
              class="shrink-0 whitespace-nowrap"
              @click="copy(rotatedSecret.key, '已复制新访问密钥')"
            >
              复制
            </UButton>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end">
          <UButton :icon="icons.check" @click="rotatedSecret = null">我已保存</UButton>
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
      :action-icon="icons.revoked"
      :busy="revokeBusy"
      :error="revokeError"
      @confirm="confirmRevoke"
      @close="revoking = null"
    />
  </article>
</template>

<style scoped>
.editor-pane {
  --canvas-max: 1320px;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg);
}
.editor-head {
  flex: none;
  padding: 16px 28px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.head-main {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.head-identity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 18rem;
}
.head-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.head-title-row h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.35;
  color: var(--ui-text-highlighted);
}
.head-status-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 7px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.status-sep {
  color: var(--ui-border-accented);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  flex: none;
}
.editor-scroll {
  container-type: inline-size;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 28px 36px;
}
.read-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 24px;
  width: 100%;
  max-width: var(--canvas-max);
  margin-inline: auto;
}
.read-main {
  min-width: 0;
}
.read-rail {
  min-width: 0;
  padding-top: 20px;
  border-top: 1px solid var(--ui-border);
}
@container (min-width: 860px) {
  .read-layout.has-rail {
    grid-template-columns: minmax(0, 1fr) 296px;
    gap: 28px;
    align-items: start;
  }
  .read-layout.has-rail .read-rail {
    position: sticky;
    top: 0;
    padding-top: 0;
    padding-left: 20px;
    border-top: 0;
    border-left: 1px solid var(--ui-border);
  }
}
.paper-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
}

/* 多维筛选条 */
.key-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter-search-wrap {
  flex: 1 1 11rem;
  min-width: 10rem;
}
.filter-clear-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.filter-clear-x:hover {
  color: var(--ui-text-highlighted);
}
.filter-select {
  min-width: 8.25rem;
  flex: 0 1 auto;
}
.filter-status-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}

/* 纯净纸墨密钥清单（零嵌套卡片） */
.key-ledger-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--ui-border);
}
.key-ledger-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--ui-border);
}
.key-ledger-row:hover {
  background: var(--ui-bg-elevated);
}
.key-ledger-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 18rem;
}
.key-ledger-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  min-width: 0;
}
.key-ledger-name {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.key-runtime {
  font-size: 12px;
  color: var(--ui-text-muted);
}
.key-prefix {
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.tag-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-toned);
  white-space: nowrap;
}
.tag-muted {
  border-color: var(--ui-border);
  color: var(--ui-text-muted);
}
.tag-focus {
  border-style: dashed;
  color: var(--ui-text-muted);
}
.tag-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  color: var(--ui-text-muted);
}
.key-ledger-aside {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex: none;
}
.key-last-used {
  font-size: 12px;
  color: var(--ui-text-dimmed);
  white-space: nowrap;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

/* 已吊销记录（默认折叠） */
.revoked-details {
  padding-top: 6px;
}
.revoked-summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
  cursor: pointer;
  list-style: none;
}
.revoked-summary::-webkit-details-marker {
  display: none;
}
.revoked-summary::marker {
  content: '';
}
.revoked-chevron,
.revoked-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
}
.revoked-chevron {
  transition: transform 0.15s ease;
}
.revoked-details[open] .revoked-chevron {
  transform: rotate(90deg);
}
.revoked-list {
  margin-top: 8px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.revoked-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
  padding: 8px 2px;
  border-bottom: 1px solid var(--ui-border);
}

/* 右侧接入辅助轨 */
.rail-sections {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.rail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail-heading {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--ui-rule);
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.rail-heading-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.rail-code-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rail-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.rail-code-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-mini-icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
}
.rail-code-line {
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
}
.rail-code-val {
  display: block;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.rail-help {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.rail-disclosure {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.rail-disclosure-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  text-align: left;
  cursor: pointer;
}
.rail-disclosure-toggle:hover {
  background: var(--ui-bg-elevated);
}
.rail-disclosure-icon {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
}
.rail-disclosure-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.rail-snippet-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.rail-pre {
  margin: 0;
  padding: 8px 9px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
  .editor-head {
    padding: 12px 14px 10px;
  }
  .head-title-row h1 {
    font-size: 19px;
  }
  .editor-scroll {
    padding: 14px 14px 32px;
  }
  .filter-search-wrap {
    flex: 1 1 100%;
  }
  .filter-select {
    flex: 1 1 calc(50% - 4px);
    min-width: 0;
  }
  .key-ledger-row {
    flex-direction: column;
    gap: 10px;
  }
  .key-ledger-aside {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }
}
</style>
