<script setup lang="ts">
import { versionLabel } from '@kioku/contracts'
import { useQuery } from '@tanstack/vue-query'
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api } from '../api/endpoints'
import AccountDataSettings from '../components/AccountDataSettings.vue'
import DataTransferPanel from '../components/DataTransferPanel.vue'
import KeysSettings from '../components/KeysSettings.vue'
import ModelSettings from '../components/ModelSettings.vue'
import { useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { useSession } from '../composables/useSession'
import { icons } from '../icons'
import { resolveSettingsSection, settingsRoute, type SettingsSection } from '../routes'

const route = useRoute()
const router = useRouter()
const { me } = useSession()

const section = computed<SettingsSection>(() =>
  resolveSettingsSection(route.params.tab, route.params.sub, route.query.sub),
)

const isModelSection = (value: SettingsSection): value is 'embed' | 'chat' | 'schedule' =>
  value === 'embed' || value === 'chat' || value === 'schedule'

// 与子视图共用查询缓存，用于左目录轨状态微标
const keysQuery = useQuery({
  queryKey: ['api-keys'] as const,
  queryFn: () => api.keys(),
  staleTime: 30_000,
})

const modelsQuery = useQuery({
  queryKey: ['models-settings'] as const,
  queryFn: () => api.modelsSettings(),
  staleTime: 30_000,
})

const sessionsQuery = useQuery({
  queryKey: ['auth-sessions'] as const,
  queryFn: () => api.sessions(),
  staleTime: 30_000,
})

const activeKeyCount = computed(() => {
  const items = keysQuery.data.value?.items
  if (!items) return null
  return items.filter((k) => !k.revokedAt).length
})

const embedMeta = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' } | null>(() => {
  const data = modelsQuery.data.value
  if (!data) return null
  if (!data.embedding?.enabled) return { text: '未配置', tone: 'warn' }
  const { total, embedded } = data.embeddingCoverage
  if (total <= 0) return { text: '已启用', tone: 'ok' }
  const pct = Math.round((embedded / total) * 100)
  return { text: `${pct}%`, tone: pct >= 100 ? 'ok' : 'warn' }
})

const chatMeta = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' } | null>(() => {
  const data = modelsQuery.data.value
  if (!data) return null
  return data.chatLlm?.enabled ? { text: '已启用', tone: 'ok' } : { text: '未配置', tone: 'warn' }
})

const scheduleMeta = computed<{ text: string; tone: 'ok' | 'warn' | 'muted' } | null>(() => {
  const dream = modelsQuery.data.value?.dream
  if (!dream) return null
  const enabled =
    (dream.enabled ? 1 : 0) + (dream.crossMemory?.enabled ? 1 : 0) + (dream.tidy?.enabled ? 1 : 0)
  return { text: `${enabled}/3`, tone: 'muted' }
})

const sessionCount = computed(() => sessionsQuery.data.value?.items.length ?? null)

interface SettingsNavItem {
  value: SettingsSection
  label: string
  icon: string
  meta?: { text: string; tone: 'ok' | 'warn' | 'muted' } | null
}

interface SettingsNavGroup {
  id: string
  label: string
  items: SettingsNavItem[]
}

const navGroups = computed<SettingsNavGroup[]>(() => [
  {
    id: 'connect',
    label: '接入',
    items: [
      {
        value: 'keys',
        label: '终端与密钥',
        icon: icons.terminal,
        meta:
          activeKeyCount.value !== null
            ? { text: String(activeKeyCount.value), tone: 'muted' }
            : null,
      },
    ],
  },
  {
    id: 'models',
    label: '模型与整理',
    items: [
      { value: 'embed', label: '嵌入与索引', icon: icons.database, meta: embedMeta.value },
      { value: 'chat', label: '对话与整理', icon: icons.sparkles, meta: chatMeta.value },
      { value: 'schedule', label: '定时计划', icon: icons.clock, meta: scheduleMeta.value },
    ],
  },
  {
    id: 'account',
    label: '账号与数据',
    items: [
      {
        value: 'account',
        label: '账号与登录设备',
        icon: icons.account,
        meta:
          sessionCount.value !== null ? { text: String(sessionCount.value), tone: 'muted' } : null,
      },
      { value: 'transfer', label: '备份与迁移', icon: icons.archive, meta: null },
    ],
  },
])

const flatNavItems = computed(() => navGroups.value.flatMap((group) => group.items))

const versionText = computed(() =>
  me.data.value?.version ? `Kioku ${versionLabel(me.data.value.version)}` : null,
)

const modelsDirty = ref(false)
const accountDirty = ref(false)
const hasDirtyForm = computed(() => modelsDirty.value || accountDirty.value)

useUnsavedChangesGuard(hasDirtyForm, {
  leavesOn: (to, from) =>
    to.name !== from.name ||
    resolveSettingsSection(to.params.tab, to.params.sub, to.query.sub) !==
      resolveSettingsSection(from.params.tab, from.params.sub, from.query.sub),
})

watch(section, () => {
  modelsDirty.value = false
  accountDirty.value = false
  void nextTick(() => {
    const activeBtn = mobileStripRef.value?.querySelector<HTMLElement>('[aria-current="page"]')
    activeBtn?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
})

const mobileStripRef = ref<HTMLElement | null>(null)

function selectSection(next: SettingsSection) {
  if (next === section.value) return
  void router.push(settingsRoute(next))
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-shell">
      <div class="settings-workspace">
        <!-- 宽屏左侧 216px 目录轨 -->
        <aside class="settings-vnav" aria-label="设置目录">
          <div class="rail-scroll">
            <template v-for="(group, idx) in navGroups" :key="group.id">
              <div v-if="idx > 0" class="rail-divider" aria-hidden="true" />
              <div class="rail-group-label">{{ group.label }}</div>
              <nav class="tree-list" :aria-label="group.label">
                <button
                  v-for="item in group.items"
                  :key="item.value"
                  type="button"
                  class="tree-item"
                  :class="{ 'is-active': section === item.value }"
                  :aria-current="section === item.value ? 'page' : undefined"
                  @click="selectSection(item.value)"
                >
                  <span class="tree-lead">
                    <UIcon :name="item.icon" class="tree-icon" aria-hidden="true" />
                    <span class="tree-label">{{ item.label }}</span>
                  </span>
                  <span
                    v-if="item.meta"
                    class="tree-meta tabular-nums"
                    :class="{
                      'is-ok': item.meta.tone === 'ok',
                      'is-warn': item.meta.tone === 'warn',
                    }"
                  >
                    {{ item.meta.text }}
                  </span>
                </button>
              </nav>
            </template>
          </div>
          <footer v-if="versionText" class="rail-foot-min font-mono">{{ versionText }}</footer>
        </aside>

        <!-- 窄屏顶部紧凑水平可滚切换条 -->
        <nav ref="mobileStripRef" class="settings-mobile-nav" aria-label="设置子页切换">
          <div class="mobile-nav-track">
            <button
              v-for="item in flatNavItems"
              :key="`m:${item.value}`"
              type="button"
              class="mobile-nav-item"
              :class="{ 'is-active': section === item.value }"
              :aria-current="section === item.value ? 'page' : undefined"
              @click="selectSection(item.value)"
            >
              <UIcon :name="item.icon" class="mobile-nav-icon" aria-hidden="true" />
              <span>{{ item.label }}</span>
              <span
                v-if="item.meta?.tone === 'warn'"
                class="mobile-nav-dot is-warn"
                aria-hidden="true"
              />
            </button>
          </div>
        </nav>

        <!-- 右侧设置详情工作面 -->
        <div class="settings-content">
          <KeysSettings v-if="section === 'keys'" />
          <ModelSettings
            v-else-if="isModelSection(section)"
            v-model:dirty="modelsDirty"
            :section="section"
          />
          <AccountDataSettings v-else-if="section === 'account'" v-model:dirty="accountDirty" />
          <DataTransferPanel v-else />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: var(--ui-bg);
}
.settings-shell {
  display: flex;
  flex: 1 1 auto;
  width: 100%;
  max-width: 1840px;
  min-width: 0;
  min-height: 0;
  margin-inline: auto;
}
@media (min-width: 1841px) {
  .settings-shell {
    border-inline: 1px solid var(--ui-border-muted);
  }
}
.settings-workspace {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
}
.settings-vnav {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--ui-bg-muted);
  border-right: 1px solid var(--ui-border-accented);
}
.rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 8px;
}
.rail-group-label {
  padding: 4px 8px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-dimmed);
}
.rail-divider {
  height: 1px;
  margin: 10px 6px;
  background: var(--ui-border);
}
.tree-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tree-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 31px;
  padding: 4px 8px;
  border-left: 2px solid transparent;
  font-size: 13px;
  line-height: 1.4;
  color: var(--ui-text-toned);
  text-align: left;
  cursor: pointer;
}
.tree-item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.tree-item.is-active {
  border-left-color: var(--ui-rule);
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.tree-lead {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}
.tree-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.tree-item.is-active .tree-icon {
  color: var(--ui-text-highlighted);
}
.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-meta {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.tree-item.is-active .tree-meta {
  color: var(--ui-text-toned);
}
.tree-meta.is-ok {
  color: var(--ui-success);
}
.tree-meta.is-warn {
  color: var(--ui-warning);
}
.rail-foot-min {
  flex: none;
  padding: 10px 14px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.settings-mobile-nav {
  display: none;
  flex: none;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--ui-border-accented);
  background: var(--ui-bg-muted);
}
.settings-mobile-nav::-webkit-scrollbar {
  display: none;
}
.mobile-nav-track {
  display: flex;
  align-items: stretch;
  min-width: max-content;
  padding: 0 8px;
  gap: 2px;
}
.mobile-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 40px;
  padding: 0 10px;
  border-bottom: 2px solid transparent;
  font-size: 13px;
  color: var(--ui-text-toned);
  white-space: nowrap;
  cursor: pointer;
}
.mobile-nav-item:hover {
  color: var(--ui-text-highlighted);
}
.mobile-nav-item.is-active {
  border-bottom-color: var(--ui-rule);
  color: var(--ui-text-highlighted);
  font-weight: 600;
}
.mobile-nav-icon {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--ui-text-muted);
}
.mobile-nav-item.is-active .mobile-nav-icon {
  color: currentColor;
}
.mobile-nav-dot {
  display: inline-block;
  flex: none;
  width: 6px;
  height: 6px;
  background: var(--ui-warning);
}
.settings-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--ui-bg);
}
@media (max-width: 1023.98px) {
  .settings-workspace {
    display: flex;
    flex-direction: column;
  }
  .settings-vnav {
    display: none;
  }
  .settings-mobile-nav {
    display: block;
  }
}
</style>
