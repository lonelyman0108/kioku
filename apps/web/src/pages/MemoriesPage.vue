<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import { parentOf, toTreeItems, type MemoryTreeItem } from '../components/memoryTree'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const spaceId = computed(() => String(route.params.spaceId))
const selectedUri = computed(() => (typeof route.query.uri === 'string' ? route.query.uri : null))
const { canWrite } = useMemoryPermissions(spaceId)

const roots = ref<MemoryTreeItem[]>([])
const loadingRoots = ref(false)
const createOpen = ref(false)
const createUri = ref('')

const folderIcons = { folder: icons.folder, file: icons.file }

async function loadRoots() {
  loadingRoots.value = true
  try {
    const domains = await api.memoryDomains(spaceId.value)
    roots.value = domains.map((d) => ({
      label: `${d.domain}://`,
      // domain 根用 domain 名作为键，与 children 接口的参数一致
      uri: d.domain,
      exists: false,
      loaded: false,
      icon: icons.folder,
      children: [
        {
          label: '加载中……',
          uri: `${d.domain}#loading`,
          exists: false,
          loaded: true,
          disabled: true,
        },
      ],
    }))
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '读取失败', color: 'error' })
  } finally {
    loadingRoots.value = false
  }
}

async function loadChildren(item: MemoryTreeItem) {
  const result = await api.memoryChildren(spaceId.value, item.uri)
  const children = toTreeItems(result, folderIcons)
  item.children = children.length ? children : undefined
  item.loaded = true
}

function find(items: MemoryTreeItem[] | undefined, uri: string): MemoryTreeItem | undefined {
  for (const item of items ?? []) {
    if (item.uri === uri) return item
    const hit = find(item.children, uri)
    if (hit) return hit
  }
  return undefined
}

// 新建或删除之后刷新受影响的那一级；父级不在树里（例如新的 domain）就整棵重载
async function refreshAround(uri: string) {
  const parent = find(roots.value, parentOf(uri))
  if (parent) await loadChildren(parent)
  else await loadRoots()
}

async function onToggle(_event: unknown, item: MemoryTreeItem) {
  if (item.loaded) return
  try {
    await loadChildren(item)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '读取失败', color: 'error' })
  }
}

function onSelect(_event: unknown, item: MemoryTreeItem) {
  if (item.exists) void router.replace({ query: { uri: item.uri } })
}

function openCreate(prefix: string) {
  createUri.value = prefix.includes('://') ? `${prefix}/` : prefix ? `${prefix}://` : ''
  createOpen.value = true
}

async function onCreated(uri: string) {
  await refreshAround(uri)
  await router.replace({ query: { uri } })
}

async function onDeleted(uri: string) {
  await router.replace({ query: {} })
  await refreshAround(uri)
}

onMounted(loadRoots)
watch(spaceId, loadRoots)
</script>

<template>
  <UDashboardPanel id="memory-tree" :default-size="28" :min-size="20" :max-size="45" resizable>
    <template #header>
      <UDashboardNavbar title="记忆">
        <template #right>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            @click="loadRoots"
          />
          <UButton v-if="canWrite" :icon="icons.add" size="sm" @click="openCreate('')">
            新建
          </UButton>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <p v-if="!loadingRoots && !roots.length" class="text-sm text-muted">
        还没有记忆。{{ canWrite ? '点「新建」写下第一条。' : '' }}
      </p>
      <UTree :items="roots" :get-key="(item) => item.uri" @toggle="onToggle" @select="onSelect" />
    </template>
  </UDashboardPanel>

  <UDashboardPanel id="memory-detail">
    <template #header>
      <UDashboardNavbar :title="selectedUri ?? '选择一条记忆'" />
    </template>
    <template #body>
      <MemoryEditor
        v-if="selectedUri"
        :key="selectedUri"
        :space-id="spaceId"
        :uri="selectedUri"
        @deleted="onDeleted"
        @create-child="openCreate"
      />
      <p v-else class="text-sm text-muted">
        在左侧树里选择一条记忆查看和编辑。虚拟节点（没有正文的路径）只能展开。
      </p>
    </template>
  </UDashboardPanel>

  <CreateMemoryModal
    v-model:open="createOpen"
    :space-id="spaceId"
    :initial-uri="createUri"
    @created="onCreated"
  />
</template>
