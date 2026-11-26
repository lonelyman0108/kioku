<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AccountDataSettings from '../components/AccountDataSettings.vue'
import KeysSettings from '../components/KeysSettings.vue'
import ModelSettings from '../components/ModelSettings.vue'
import PageHead from '../components/ui/PageHead.vue'
import { useUnsavedChangesGuard } from '../composables/unsavedChanges'
import { icons } from '../icons'
import { SETTINGS_TABS, settingsRoute, type SettingsTab } from '../routes'

const route = useRoute()
const router = useRouter()

const tab = computed<SettingsTab>(() => {
  const raw = route.params.tab
  return typeof raw === 'string' && (SETTINGS_TABS as readonly string[]).includes(raw)
    ? (raw as SettingsTab)
    : 'keys'
})

const tabItems: TabsItem[] = [
  { value: 'keys', label: '连接与终端', icon: icons.keys },
  { value: 'models', label: '模型', icon: icons.models },
  { value: 'account', label: '账号与数据', icon: icons.account },
]

const navGroups: { value: SettingsTab; label: string; desc: string; icon: string }[] = [
  { value: 'keys', label: '连接与终端', desc: '接入地址与访问密钥', icon: icons.keys },
  { value: 'models', label: '模型', desc: '向量检索与自动整理', icon: icons.models },
  { value: 'account', label: '账号与数据', desc: '资料、设备与导入导出', icon: icons.account },
]

const modelsDirty = ref(false)
useUnsavedChangesGuard(modelsDirty, {
  leavesOn: (to, from) => to.name !== from.name || to.params.tab !== from.params.tab,
})

watch(tab, () => {
  if (tab.value !== 'models') modelsDirty.value = false
})

function setTab(value: string | number) {
  void router.push(settingsRoute(value as SettingsTab))
}
</script>

<template>
  <div class="settings-page">
    <div class="settings-head-bar">
      <div class="settings-head-inner">
        <PageHead title="设置" />
      </div>
    </div>

    <div class="settings-mobile-tabs">
      <UTabs
        :model-value="tab"
        :items="tabItems"
        :content="false"
        variant="link"
        size="md"
        :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-3 py-0 h-11 text-sm/5' }"
        @update:model-value="setTab"
      />
    </div>

    <div class="settings-workspace">
      <nav class="settings-vnav" aria-label="设置分组">
        <button
          v-for="item in navGroups"
          :key="item.value"
          type="button"
          class="vnav-item"
          :class="{ active: tab === item.value }"
          :aria-current="tab === item.value ? 'page' : undefined"
          @click="setTab(item.value)"
        >
          <UIcon :name="item.icon" class="vnav-icon" aria-hidden="true" />
          <span class="vnav-text">
            <span class="vnav-label">{{ item.label }}</span>
            <span class="vnav-desc">{{ item.desc }}</span>
          </span>
        </button>
      </nav>

      <div class="settings-content">
        <KeysSettings v-if="tab === 'keys'" />
        <ModelSettings v-else-if="tab === 'models'" v-model:dirty="modelsDirty" />
        <AccountDataSettings v-else />
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.settings-head-bar {
  border-bottom: 1px solid var(--ui-rule);
}
.settings-head-inner {
  width: 100%;
  max-width: 76rem;
  margin-inline: auto;
}
.settings-mobile-tabs {
  display: none;
  padding: 0 8px;
  border-bottom: 1px solid var(--ui-border-accented);
}
.settings-workspace {
  display: grid;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: 40px;
  align-items: start;
  width: 100%;
  max-width: 76rem;
  margin-inline: auto;
  padding: 28px 32px 56px;
}
.settings-vnav {
  position: sticky;
  top: 24px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-right: 16px;
  border-right: 1px solid var(--ui-border);
}
.vnav-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-left: 2px solid transparent;
  text-align: left;
  color: var(--ui-text-muted);
  cursor: pointer;
}
.vnav-item:hover {
  background: var(--ui-bg-elevated);
  color: var(--ui-text-highlighted);
}
.vnav-item.active {
  border-left-color: var(--ui-rule);
  background: var(--ui-bg-muted);
  color: var(--ui-text-highlighted);
}
.vnav-icon {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--ui-text-dimmed);
}
.vnav-item.active .vnav-icon {
  color: var(--ui-text-highlighted);
}
.vnav-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.vnav-label {
  font-size: 14px;
  line-height: 1.4;
}
.vnav-item.active .vnav-label {
  font-weight: 600;
}
.vnav-desc {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ui-text-dimmed);
}
.settings-content {
  min-width: 0;
  max-width: 56rem;
}
@media (max-width: 1023.98px) {
  .settings-mobile-tabs {
    display: block;
  }
  .settings-workspace {
    display: block;
    padding: 18px 16px 40px;
  }
  .settings-vnav {
    display: none;
  }
  .settings-content {
    max-width: none;
  }
}
</style>
