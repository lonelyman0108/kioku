<script setup lang="ts">
import type { CredentialKind, CredentialMeta } from '@kioku/contracts'
import { computed } from 'vue'

import {
  CREDENTIAL_REALM_ALL,
  CREDENTIAL_REALM_EMPTY,
  CREDENTIAL_REALM_UNSCOPED,
} from '../credentials'
import { icons } from '../icons'
import { CREDENTIAL_KIND_ORDER, credentialKindIcons, credentialKindLabels } from '../labels'

const props = defineProps<{
  kindFilter: 'all' | CredentialKind
  realmFilter: string
  items: readonly CredentialMeta[]
  knownRealms: readonly string[]
}>()

const emit = defineEmits<{
  'update:kindFilter': [value: 'all' | CredentialKind]
  'update:realmFilter': [value: string]
}>()

const totalCount = computed(() => props.items.length)

const countByKind = computed<Record<CredentialKind, number>>(() => {
  const counts: Record<CredentialKind, number> = {
    login: 0,
    api: 0,
    database: 0,
    ssh: 0,
    secret: 0,
  }
  for (const item of props.items) {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1
  }
  return counts
})

const realmCounts = computed(() => {
  const map = new Map<string, number>()
  for (const realm of props.knownRealms) {
    map.set(realm, 0)
  }
  for (const item of props.items) {
    if (!item.allowedRealms?.length) continue
    for (const realm of item.allowedRealms) {
      map.set(realm, (map.get(realm) ?? 0) + 1)
    }
  }
  return [...map.entries()].map(([realm, count]) => ({ realm, count }))
})

const unscopedCount = computed(
  () => props.items.filter((item) => item.allowedRealms === null).length,
)

const genericOnlyCount = computed(
  () =>
    props.items.filter((item) => item.allowedRealms !== null && item.allowedRealms.length === 0)
      .length,
)

function selectKind(next: 'all' | CredentialKind) {
  emit('update:kindFilter', next)
  if (next === 'all') emit('update:realmFilter', CREDENTIAL_REALM_ALL)
}

function toggleRealm(next: string) {
  emit('update:realmFilter', props.realmFilter === next ? CREDENTIAL_REALM_ALL : next)
}
</script>

<template>
  <aside class="index-rail" aria-label="凭据筛选目录">
    <div class="rail-scroll">
      <div class="rail-section-title">类型</div>
      <nav class="tree-group" aria-label="按凭据类型筛选">
        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': kindFilter === 'all' && realmFilter === CREDENTIAL_REALM_ALL }"
          :aria-current="
            kindFilter === 'all' && realmFilter === CREDENTIAL_REALM_ALL ? 'page' : undefined
          "
          @click="selectKind('all')"
        >
          <span class="tree-item-lead">
            <UIcon :name="icons.credentials" class="tree-icon" aria-hidden="true" />
            <span class="tree-label">全部凭据</span>
          </span>
          <span class="tree-count tabular-nums">{{ totalCount }}</span>
        </button>

        <button
          v-for="kind in CREDENTIAL_KIND_ORDER"
          :key="kind"
          type="button"
          class="tree-item"
          :class="{ 'is-active': kindFilter === kind }"
          :aria-current="kindFilter === kind ? 'page' : undefined"
          @click="selectKind(kind)"
        >
          <span class="tree-item-lead">
            <UIcon :name="credentialKindIcons[kind]" class="tree-icon" aria-hidden="true" />
            <span class="tree-label">{{ credentialKindLabels[kind] }}</span>
          </span>
          <span class="tree-count tabular-nums">{{ countByKind[kind] }}</span>
        </button>
      </nav>

      <div class="rail-divider" aria-hidden="true" />
      <div class="rail-section-title">场域</div>
      <nav class="tree-group" aria-label="按允许场域筛选">
        <button
          v-for="entry in realmCounts"
          :key="entry.realm"
          type="button"
          class="tree-item"
          :class="{ 'is-active': realmFilter === entry.realm }"
          :aria-pressed="realmFilter === entry.realm"
          @click="toggleRealm(entry.realm)"
        >
          <span class="tree-item-lead">
            <UIcon :name="icons.realm" class="tree-icon" aria-hidden="true" />
            <span class="tree-label font-mono">{{ entry.realm }}</span>
          </span>
          <span class="tree-count tabular-nums">{{ entry.count }}</span>
        </button>

        <button
          type="button"
          class="tree-item"
          :class="{ 'is-active': realmFilter === CREDENTIAL_REALM_UNSCOPED }"
          :aria-pressed="realmFilter === CREDENTIAL_REALM_UNSCOPED"
          @click="toggleRealm(CREDENTIAL_REALM_UNSCOPED)"
        >
          <span class="tree-item-lead">
            <UIcon :name="icons.globe" class="tree-icon" aria-hidden="true" />
            <span class="tree-label">不限场域</span>
          </span>
          <span class="tree-count tabular-nums">{{ unscopedCount }}</span>
        </button>

        <button
          v-if="genericOnlyCount > 0"
          type="button"
          class="tree-item"
          :class="{ 'is-active': realmFilter === CREDENTIAL_REALM_EMPTY }"
          :aria-pressed="realmFilter === CREDENTIAL_REALM_EMPTY"
          @click="toggleRealm(CREDENTIAL_REALM_EMPTY)"
        >
          <span class="tree-item-lead">
            <UIcon :name="icons.lock" class="tree-icon" aria-hidden="true" />
            <span class="tree-label">仅无场域</span>
          </span>
          <span class="tree-count tabular-nums">{{ genericOnlyCount }}</span>
        </button>
      </nav>
    </div>
  </aside>
</template>

<style scoped>
.index-rail {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--ui-bg-muted);
}
.rail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 8px 14px;
}
.rail-section-title {
  padding: 2px 8px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ui-text-dimmed);
}
.rail-divider {
  height: 1px;
  margin: 10px 6px;
  background: var(--ui-border);
}
.tree-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tree-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 30px;
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
.tree-item-lead {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}
.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.tree-count {
  flex: none;
  font-size: 12px;
  color: var(--ui-text-dimmed);
}
.tree-item.is-active .tree-count {
  color: var(--ui-text-toned);
}
</style>
