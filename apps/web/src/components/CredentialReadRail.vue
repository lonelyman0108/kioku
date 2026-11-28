<script setup lang="ts">
import type { ApiKeyView, CredentialMeta, CredentialReferenceItem } from '@kioku/contracts'
import { computed, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'

import { useCopy } from '../composables/useCopy'
import { buildKiokuRunCommand, canKeyAccessCredential } from '../credentials'
import { icons } from '../icons'
import { placeholderOf } from '../placeholders'
import { entryRoute, settingsRoute } from '../routes'
import { runtimeName } from '../runtimes'
import { formatRelative, formatTime } from '../time'

const props = withDefaults(
  defineProps<{
    credential: CredentialMeta
    references: readonly CredentialReferenceItem[]
    referencesLoading?: boolean
    referencesError?: boolean
    apiKeys: readonly ApiKeyView[]
    showDelete?: boolean
  }>(),
  {
    referencesLoading: false,
    referencesError: false,
    showDelete: true,
  },
)

const emit = defineEmits<{
  requestDelete: []
}>()

const router = useRouter()
const copy = useCopy()

const refsExpanded = ref(true)
const refsListId = useId()
const keysExpanded = ref(false)
const keysListId = useId()

watch(
  () => props.credential.id,
  () => {
    refsExpanded.value = true
    keysExpanded.value = false
  },
)

const isPasskeyOnly = computed(
  () => props.credential.kind === 'login' && props.credential.passkeyManualOnly,
)
const defaultPlaceholder = computed(() => placeholderOf(props.credential.slug))
const runCommand = computed(() => buildKiokuRunCommand(props.credential))

const matchedKeys = computed(() =>
  props.apiKeys.filter((k) => canKeyAccessCredential(k, props.credential)),
)

function openMemory(shortId: string) {
  void router.push(entryRoute(shortId))
}

function formatRefFields(fields: readonly (string | null)[]): string[] {
  return fields.map((f) => (f === null ? '默认' : `#${f}`))
}
</script>

<template>
  <div class="cred-rail-stack">
    <!-- 命令行注入与占位符 -->
    <section class="rail-section">
      <h2 class="rail-heading">
        <UIcon :name="icons.terminal" class="rail-heading-icon" aria-hidden="true" />
        <span>命令行注入</span>
      </h2>

      <div class="rail-code-block">
        <div class="rail-code-head">
          <span>记忆占位符</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="icons.copy"
            class="shrink-0 whitespace-nowrap"
            @click="copy(defaultPlaceholder)"
          >
            复制
          </UButton>
        </div>
        <div class="rail-code-line">
          <code class="rail-code-val">{{ defaultPlaceholder }}</code>
        </div>
      </div>

      <div v-if="!isPasskeyOnly" class="rail-code-block">
        <div class="rail-code-head">
          <span>单行注入示例</span>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="icons.copy"
            class="shrink-0 whitespace-nowrap"
            @click="copy(runCommand)"
          >
            复制
          </UButton>
        </div>
        <pre class="rail-pre">{{ runCommand }}</pre>
      </div>
      <p v-else class="rail-note">
        当前账号已标记为人工登录（含 Passkey），不生成命令行自动注入示例。
      </p>
    </section>

    <!-- 被引用记忆 -->
    <section class="rail-history-disclosure">
      <div class="rail-disclosure-head">
        <button
          type="button"
          class="rail-disclosure-toggle"
          :aria-expanded="refsExpanded"
          :aria-controls="refsListId"
          @click="refsExpanded = !refsExpanded"
        >
          <UIcon
            :name="icons.chevronRight"
            class="rail-disclosure-chevron"
            :class="{ 'is-open': refsExpanded }"
            aria-hidden="true"
          />
          <UIcon :name="icons.memories" class="rail-heading-icon" aria-hidden="true" />
          <span>被引用记忆</span>
          <span class="rail-heading-count tabular-nums">{{ references.length }}</span>
        </button>
      </div>

      <div v-if="refsExpanded" :id="refsListId" class="rail-disclosure-body">
        <div v-if="referencesLoading" class="space-y-1.5 py-1">
          <USkeleton class="h-8 w-full" />
          <USkeleton class="h-8 w-4/5" />
        </div>
        <p v-else-if="referencesError" class="rail-empty">加载引用记录失败，请稍后重试。</p>
        <ol v-else-if="references.length" class="ref-list">
          <li v-for="refItem in references" :key="refItem.id">
            <button
              type="button"
              class="ref-btn"
              :title="`${refItem.title}（${refItem.shortId}）`"
              @click="openMemory(refItem.shortId)"
            >
              <span class="ref-top">
                <span class="ref-title">{{ refItem.title }}</span>
                <span class="ref-id font-mono">{{ refItem.shortId }}</span>
              </span>
              <span class="ref-sub">
                <span
                  v-for="tag in formatRefFields(refItem.fields)"
                  :key="tag"
                  class="ref-field-chip font-mono"
                >
                  {{ tag }}
                </span>
                <time :datetime="refItem.updatedAt">{{ formatRelative(refItem.updatedAt) }}</time>
              </span>
            </button>
          </li>
        </ol>
        <p v-else class="rail-empty">暂无活跃记忆引用此凭据。</p>
      </div>
    </section>

    <!-- 访问范围与信息 -->
    <section class="rail-section">
      <h2 class="rail-heading">
        <UIcon :name="icons.shieldCheck" class="rail-heading-icon" aria-hidden="true" />
        <span>访问范围与信息</span>
      </h2>

      <div class="rail-history-disclosure">
        <div class="rail-disclosure-head">
          <button
            type="button"
            class="rail-disclosure-toggle"
            :aria-expanded="keysExpanded"
            :aria-controls="keysListId"
            @click="keysExpanded = !keysExpanded"
          >
            <UIcon
              :name="icons.chevronRight"
              class="rail-disclosure-chevron"
              :class="{ 'is-open': keysExpanded }"
              aria-hidden="true"
            />
            <span class="scope-summary-text tabular-nums">
              {{
                matchedKeys.length > 0
                  ? `${matchedKeys.length} 个访问密钥有权解析此凭据`
                  : '暂无访问密钥有权解析此凭据'
              }}
            </span>
          </button>
        </div>

        <div v-if="keysExpanded" :id="keysListId" class="rail-disclosure-body">
          <ul v-if="matchedKeys.length" class="key-list">
            <li v-for="k in matchedKeys" :key="k.id" class="key-item">
              <div class="key-top">
                <span class="key-name">{{ k.name }}</span>
                <span class="key-prefix font-mono">{{ k.prefix }}</span>
              </div>
              <div class="key-meta">
                <span>{{ runtimeName(k.runtimeFamily) }}</span>
                <span>·</span>
                <span class="font-mono">
                  {{ k.allowedRealms === null ? '全部场域' : k.allowedRealms.join('、') }}
                </span>
              </div>
            </li>
          </ul>
          <p v-else class="rail-empty">可在设置中为对应场域的访问密钥开启「允许解析托管凭据」。</p>
          <div class="rail-link-foot">
            <RouterLink :to="settingsRoute('keys')" class="text-primary rail-more-link">
              管理访问密钥
            </RouterLink>
          </div>
        </div>
      </div>

      <dl class="info-list">
        <div class="info-row">
          <dt>创建时间</dt>
          <dd :title="formatTime(credential.createdAt)">{{ formatTime(credential.createdAt) }}</dd>
        </div>
        <div class="info-row">
          <dt>更新时间</dt>
          <dd :title="formatTime(credential.updatedAt)">{{ formatTime(credential.updatedAt) }}</dd>
        </div>
      </dl>

      <div v-if="showDelete" class="rail-danger-foot">
        <UButton
          size="xs"
          color="error"
          variant="ghost"
          :icon="icons.remove"
          @click="emit('requestDelete')"
        >
          删除凭据
        </UButton>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cred-rail-stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.rail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rail-heading {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding-bottom: 4px;
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
.rail-heading-count {
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-dimmed);
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
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-code-line {
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
}
.rail-code-val {
  display: block;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-highlighted);
  overflow-wrap: anywhere;
}
.rail-pre {
  margin: 0;
  padding: 8px 9px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-bright);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.rail-note,
.rail-empty {
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ui-text-muted);
}
.rail-history-disclosure {
  border: 1px solid var(--ui-border);
  background: var(--ui-bg-muted);
}
.rail-disclosure-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
}
.rail-disclosure-toggle {
  display: inline-flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
  text-align: left;
  cursor: pointer;
}
.rail-disclosure-chevron {
  display: inline-block;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--ui-text-muted);
  transition: transform 0.12s ease;
}
.rail-disclosure-chevron.is-open {
  transform: rotate(90deg);
}
.rail-disclosure-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px 8px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-bg);
}
.scope-summary-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ref-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ref-btn {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 6px 2px;
  border-bottom: 1px solid var(--ui-border-muted);
  text-align: left;
  cursor: pointer;
}
.ref-list li:last-child .ref-btn {
  border-bottom: 0;
}
.ref-btn:hover {
  background: var(--ui-bg-elevated);
}
.ref-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.ref-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.ref-id {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.ref-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.ref-field-chip {
  padding: 0 5px;
  border: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
  font-size: 12px;
  line-height: 1.4;
  color: var(--ui-text-toned);
}
.key-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.key-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 0;
  border-bottom: 1px solid var(--ui-border-muted);
}
.key-item:last-child {
  border-bottom: 0;
}
.key-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.key-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-text-highlighted);
}
.key-prefix {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.key-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--ui-text-muted);
}
.rail-link-foot {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px solid var(--ui-border-muted);
}
.rail-more-link {
  font-size: 12px;
}
.info-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  font-size: 12px;
}
.info-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 0;
  border-bottom: 1px solid var(--ui-border-muted);
}
.info-row:last-child {
  border-bottom: 0;
}
.info-row dt {
  color: var(--ui-text-muted);
  white-space: nowrap;
}
.info-row dd {
  margin: 0;
  color: var(--ui-text-toned);
  text-align: right;
}
.rail-danger-foot {
  display: flex;
  justify-content: flex-start;
  padding-top: 6px;
  border-top: 1px solid var(--ui-border);
}
</style>
