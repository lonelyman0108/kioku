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
    <PageHead title="设置" />

    <div class="settings-tabs">
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

    <div class="settings-body">
      <KeysSettings v-if="tab === 'keys'" />
      <ModelSettings v-else-if="tab === 'models'" v-model:dirty="modelsDirty" />
      <AccountDataSettings v-else />
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
}
.settings-tabs {
  padding: 0 24px;
  border-top: 1px solid var(--ui-rule);
  border-bottom: 1px solid var(--ui-border-accented);
}
.settings-body {
  max-width: 58rem;
  padding: 24px 32px 56px;
}
@media (max-width: 1023.98px) {
  .settings-tabs {
    padding: 0 8px;
  }
  .settings-body {
    padding: 18px 16px 40px;
  }
}
</style>
