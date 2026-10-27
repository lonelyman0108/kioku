<script setup lang="ts">
import type { BreadcrumbItem, TabsItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import type { MemoryView, Sensitivity } from '@kioku/contracts'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import DeletedMemories from '../components/DeletedMemories.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryListView from '../components/MemoryListView.vue'
import {
  ancestorsOf,
  depthOf,
  lastSegment,
  parentOf,
  toTreeItems,
  type MemoryTreeItem,
} from '../components/memoryTree'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { icons } from '../icons'
import { layerShortLabels, sensitivityLabels } from '../labels'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const spaceId = computed(() => String(route.params.spaceId))
const selectedUri = computed(() => (typeof route.query.uri === 'string' ? route.query.uri : null))
const { canWrite } = useMemoryPermissions(spaceId)

// 地址里除了选中的 uri，还有视图与列表的筛选条件：换选中的记忆时保留它们
function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete query[key]
    else query[key] = value
  }
  return { query }
}
function select(uri: string | null) {
  return router.replace(withQuery({ uri }))
}

type View = 'tree' | 'list' | 'deleted'
const views: View[] = ['tree', 'list', 'deleted']
const viewItems: TabsItem[] = [
  { label: '树', value: 'tree', icon: icons.tree },
  { label: '列表', value: 'list', icon: icons.list },
  { label: '已删除', value: 'deleted', icon: icons.remove },
]
const view = computed<View>(() => views.find((v) => v === route.query.view) ?? 'tree')
function setView(value: string | number) {
  void router.replace(withQuery({ view: value === 'tree' ? null : String(value) }))
}

const roots = ref<MemoryTreeItem[]>([])
// 展开的节点由这里管理：重新载入某一级之后，要据此把展开着的子节点也重新加载
const expanded = ref<string[]>([])
const loadingRoots = ref(false)
const createOpen = ref(false)
const createUri = ref('')

const folderIcons = { folder: icons.folder, file: icons.file }
// 树上的敏感级：公开不标，机密画锁，其余画一个点
const sensitivityDots: Partial<Record<Sensitivity, string>> = {
  internal: 'bg-info',
  private: 'bg-warning',
}

function failed(err: unknown) {
  toast.add({ title: err instanceof ApiError ? err.message : '读取失败', color: 'error' })
}

// 列表、已删除、domain 与关键词索引都按查询缓存；树按需加载，由下面的函数单独刷新
function invalidateLists() {
  for (const key of ['memory-list', 'memory-deleted', 'memory-domains', 'memory-glossary']) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId.value] })
  }
}

async function loadRoots() {
  loadingRoots.value = true
  // 切换空间时上一次请求可能后到，结果属于别的空间就丢掉
  const forSpace = spaceId.value
  try {
    const domains = await api.memoryDomains(forSpace)
    if (forSpace !== spaceId.value) return
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
    await restoreExpanded()
  } catch (err) {
    failed(err)
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

// 重新载入某一级之后，之前展开着的节点在新的子节点里还没加载：由浅到深把它们重新加载，
// 已经不存在的从展开列表里去掉；否则这些节点会一直显示「加载中」。
// 只去掉不存在的，加载期间用户自己展开或收起的不受影响
async function restoreExpanded() {
  const dropped = new Set<string>()
  for (const key of [...expanded.value].sort((a, b) => depthOf(a) - depthOf(b))) {
    const item = find(roots.value, key)
    if (!item?.children) {
      dropped.add(key)
      continue
    }
    if (!item.loaded) {
      try {
        await loadChildren(item)
      } catch {
        dropped.add(key)
      }
    }
  }
  if (dropped.size) expanded.value = expanded.value.filter((key) => !dropped.has(key))
}

// 展开到某个节点，例如打开带 ?uri= 的链接、从列表或搜索里选中、新建之后
async function reveal(uri: string) {
  expanded.value = [...new Set([...expanded.value, ...ancestorsOf(uri)])]
  await restoreExpanded()
}

// 新建、删除或移动之后刷新受影响的那一级；父级不在树里（例如新的 domain）就整棵重载。
// 上一级被删空、成了不存在的虚拟节点时接口返回 404，再往上一级刷新
async function refreshAround(uri: string) {
  for (let key = parentOf(uri); ; key = parentOf(key)) {
    const parent = find(roots.value, key)
    if (!parent) return loadRoots()
    try {
      await loadChildren(parent)
      // domain 里的最后一条也删了：整棵重载，让这个 domain 从树里消失
      if (!key.includes('://') && !parent.children) return loadRoots()
      return restoreExpanded()
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404 || !key.includes('://')) throw err
    }
  }
}

// 树的加载一次只跑一个：几次重载同时进行时，后面的会对着只载入一半的树判断哪些展开的节点已经不在了，
// 把还在的节点收起来。只在事件处理里排队，上面的函数互相调用时不再排队，否则会等自己。
// 新建、移动、撤销删除之后先把刷新排进去再切到那一条：对 selectedUri 的监听把展开排在刷新后面，
// 对着刷新过的树展开到新的位置；切过去也不用等树加载完
let treeTask: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = treeTask.then(task, task)
  treeTask = run.catch(() => undefined)
  return run
}

// 某个 URI 上的记忆没了或换了一条（删除、移走、新建）：清掉它的缓存，再打开时重新读取
function resetMemory(uri: string) {
  void queryClient.resetQueries({ queryKey: ['memory', spaceId.value, uri], exact: true })
}

function refresh() {
  invalidateLists()
  void serially(loadRoots)
}

async function onToggle(_event: unknown, item: MemoryTreeItem) {
  if (item.loaded) return
  try {
    await loadChildren(item)
  } catch (err) {
    failed(err)
  }
}

// 不让树自己记选中状态，选中只跟着地址走：切换被取消时高亮留在原处，点虚拟目录也不会高亮
function onSelect(event: Event, item: MemoryTreeItem) {
  event.preventDefault()
  if (item.exists) void select(item.uri)
}

function openCreate(prefix: string) {
  createUri.value = prefix.includes('://') ? `${prefix}/` : prefix ? `${prefix}://` : ''
  createOpen.value = true
}

async function onCreated(uri: string) {
  // 这个 URI 上可能还留着之前删掉的那条的缓存
  resetMemory(uri)
  invalidateLists()
  void serially(() => refreshAround(uri)).catch(failed)
  await select(uri)
}

async function onDeleted(uri: string) {
  await select(null)
  // 等编辑器卸载之后再清缓存，免得它重新读取一次、闪出「不存在」
  await nextTick()
  resetMemory(uri)
  invalidateLists()
  await serially(() => refreshAround(uri)).catch(failed)
}

// 保存、恢复或只改了层之后，树上这一项的标记跟着变
function onChanged(memory: MemoryView) {
  const item = find(roots.value, memory.uri)
  if (item) {
    Object.assign(item, {
      layer: memory.layer,
      sensitivity: memory.sensitivity,
      priority: memory.priority,
    })
  }
  invalidateLists()
}

async function onMoved(memory: MemoryView, from: string) {
  if (memory.uri === from) return onChanged(memory)
  invalidateLists()
  void serially(async () => {
    await refreshAround(from).catch(failed)
    await refreshAround(memory.uri).catch(failed)
  })
  // 原来的 URI 上已经没有这条记忆了：等原来的编辑器卸载后清掉它的缓存，退回去时重新读取。
  // 没切过去（导航被取消）时编辑器还在用它，不清
  if (!(await select(memory.uri))) {
    await nextTick()
    resetMemory(from)
  }
}

async function onUndeleted(uri: string) {
  invalidateLists()
  void serially(() => refreshAround(uri)).catch(failed)
  await select(uri)
}

// 正文里点了别的记忆的关键词：像链接一样跳过去，可以后退回来
function openLinked(uri: string) {
  void router.push(withQuery({ uri }))
}

onMounted(() =>
  serially(async () => {
    await loadRoots()
    if (selectedUri.value) await reveal(selectedUri.value)
  }),
)
watch(spaceId, () => {
  expanded.value = []
  // 新建窗口里的内容属于上一个空间，不能带到新空间去提交
  createOpen.value = false
  void serially(loadRoots)
})
// 从列表、搜索或正文的链接选中时，树也展开到那一条，切回树视图时看得到
watch(selectedUri, (uri) => {
  if (uri) void serially(() => reveal(uri))
})

// 树的选中状态跟着地址走：切换被取消（例如有未保存的修改）时，高亮也留在原来的节点
const selectedItem = computed(() =>
  selectedUri.value ? find(roots.value, selectedUri.value) : undefined,
)

// 详情上方的路径；上一级本身是记忆、并且树里已经载入时可以点过去
const crumbs = computed<BreadcrumbItem[]>(() => {
  const uri = selectedUri.value
  if (!uri) return []
  const ancestors = ancestorsOf(uri)
  return [
    ...ancestors.map((key) => {
      const label = key.includes('://') ? lastSegment(key) : `${key}://`
      return find(roots.value, key)?.exists ? { label, to: withQuery({ uri: key }) } : { label }
    }),
    { label: lastSegment(uri) },
  ]
})
</script>

<template>
  <!-- 窄屏放不下两栏：选中记忆时只显示详情，返回后再显示树 -->
  <UDashboardPanel
    id="memory-tree"
    :default-size="30"
    :min-size="20"
    :max-size="45"
    resizable
    :class="selectedUri ? 'max-lg:hidden' : ''"
  >
    <template #header>
      <UDashboardNavbar title="记忆">
        <template #right>
          <UButton
            :icon="icons.refresh"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            @click="refresh"
          />
          <UButton v-if="canWrite" :icon="icons.add" size="sm" @click="openCreate('')">
            新建
          </UButton>
        </template>
      </UDashboardNavbar>
      <UDashboardToolbar>
        <UTabs
          :model-value="view"
          :items="viewItems"
          :content="false"
          variant="link"
          size="sm"
          class="w-full"
          @update:model-value="setView"
        />
      </UDashboardToolbar>
    </template>
    <template #body>
      <template v-if="view === 'tree'">
        <p v-if="!loadingRoots && !roots.length" class="text-sm text-muted">
          还没有记忆。{{ canWrite ? '点「新建」写下第一条。' : '' }}
        </p>
        <UTree
          v-model:expanded="expanded"
          :model-value="selectedItem"
          :items="roots"
          :get-key="(item) => item.uri"
          @toggle="onToggle"
          @select="onSelect"
        >
          <template #item-label="{ item }">
            <span class="flex min-w-0 items-center gap-1.5">
              <span class="truncate">{{ item.label }}</span>
              <template v-if="item.exists && item.layer && item.sensitivity">
                <span class="shrink-0 text-xs text-dimmed">{{ layerShortLabels[item.layer] }}</span>
                <UIcon
                  v-if="item.sensitivity === 'secret'"
                  :name="icons.secret"
                  class="size-3 shrink-0 text-error"
                  role="img"
                  :aria-label="sensitivityLabels.secret"
                />
                <span
                  v-else-if="sensitivityDots[item.sensitivity]"
                  class="size-1.5 shrink-0 rounded-full"
                  :class="sensitivityDots[item.sensitivity]"
                  role="img"
                  :aria-label="sensitivityLabels[item.sensitivity]"
                  :title="sensitivityLabels[item.sensitivity]"
                />
                <span
                  v-if="item.priority !== null && item.priority !== undefined && item.priority <= 1"
                  class="shrink-0 text-xs font-medium text-primary"
                >
                  P{{ item.priority }}
                </span>
              </template>
            </span>
          </template>
        </UTree>
      </template>
      <!-- 列表与已删除切走时不卸载：保留筛选与位置，切走之前发出的撤销删除完成后也还能通知到这里 -->
      <KeepAlive>
        <MemoryListView
          v-if="view === 'list'"
          :space-id="spaceId"
          :selected-uri="selectedUri"
          @select="select"
        />
        <DeletedMemories
          v-else-if="view === 'deleted'"
          :space-id="spaceId"
          @restored="onUndeleted"
        />
      </KeepAlive>
    </template>
  </UDashboardPanel>

  <UDashboardPanel id="memory-detail" :class="selectedUri ? '' : 'max-lg:hidden'">
    <template #header>
      <!-- 标题里放的是面包屑导航，不用默认的 h1 -->
      <UDashboardNavbar :as="{ title: 'div' }">
        <template #leading>
          <UButton
            v-if="selectedUri"
            :icon="icons.back"
            color="neutral"
            variant="ghost"
            class="lg:hidden"
            aria-label="返回"
            @click="select(null)"
          />
        </template>
        <template #title>
          <UBreadcrumb v-if="crumbs.length" :items="crumbs" class="min-w-0" />
          <span v-else>选择一条记忆</span>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <MemoryEditor
        v-if="selectedUri"
        :key="`${spaceId}|${selectedUri}`"
        :space-id="spaceId"
        :uri="selectedUri"
        @deleted="onDeleted"
        @create-child="openCreate"
        @changed="onChanged"
        @moved="onMoved"
        @open="openLinked"
      />
      <p v-else class="text-sm text-muted">
        在左侧选择一条记忆查看和编辑。树上的虚拟节点（没有正文的路径）只能展开。
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
