<script setup lang="ts">
import type { TabsItem } from '@nuxt/ui'
import { useToast } from '@nuxt/ui/composables'
import {
  LAYERS,
  SENSITIVITIES,
  type ConsoleMemoryView,
  type Layer,
  type PersonaInfo,
  type Sensitivity,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import AppPanel from '../components/AppPanel.vue'
import CreateMemoryModal from '../components/CreateMemoryModal.vue'
import DeletedMemories from '../components/DeletedMemories.vue'
import ExpiredMemories from '../components/ExpiredMemories.vue'
import Hint from '../components/Hint.vue'
import MemoryEditor from '../components/MemoryEditor.vue'
import MemoryListView from '../components/MemoryListView.vue'
import MemoryRootPanel from '../components/MemoryRootPanel.vue'
import PersonaFormModal from '../components/PersonaFormModal.vue'
import PersonaPanel from '../components/PersonaPanel.vue'
import {
  ancestorsOf,
  depthOf,
  entityItems,
  focusAfterSelect,
  guideLines,
  lastSegment,
  nodeKeyOf,
  nodeOfItem,
  parentOf,
  parentRow,
  parseNodeParam,
  rootItems,
  selectable,
  toTreeItems,
  treeRowPlaces,
  typeaheadMatch,
  type MemoryTreeItem,
} from '../components/memoryTree'
import MemoryFlags from '../components/strata/MemoryFlags.vue'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import StrataRibbon from '../components/strata/StrataRibbon.vue'
import StrataSwatch from '../components/strata/StrataSwatch.vue'
import { CURATED_STACK, layerTotal, tallyCounts } from '../components/strata/strata'
import { useMemoryPermissions } from '../composables/useMemoryPermissions'
import { useViewport } from '../composables/useViewport'
import { icons } from '../icons'
import { invalidateInboxCounts } from '../inbox'
import { layerLabels } from '../labels'
import { statsChanged } from '../memoryDetail'
import type { ReadState } from '../query'

const route = useRoute()
const router = useRouter()
const toast = useToast()
const queryClient = useQueryClient()
const spaceId = computed(() => String(route.params.spaceId))
// 选中的是一条记忆（uri），还是目录里的一个根、人格或应用（node，见 parseNodeParam）：地址里只有其中一个
const selectedUri = computed(() => (typeof route.query.uri === 'string' ? route.query.uri : null))
const selectedNode = computed(() =>
  !selectedUri.value && typeof route.query.node === 'string' ? route.query.node : null,
)
const nodeRef = computed(() => parseNodeParam(selectedNode.value))
const { apps, role, canWrite } = useMemoryPermissions(spaceId)
// 人格的增删改和服务端一样：空间所有者与编辑者
const canEditPersonas = computed(() => role.value === 'owner' || role.value === 'editor')

// 地址里除了选中的那一项，还有视图与列表的筛选条件：换选中的记忆时保留它们
function withQuery(changes: Record<string, string | null>) {
  const query = { ...route.query }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete query[key]
    else query[key] = value
  }
  return { query }
}
function select(uri: string | null) {
  return router.replace(withQuery({ uri, node: null }))
}
function selectNode(node: string | null) {
  return router.replace(withQuery({ node, uri: null }))
}

type View = 'tree' | 'list' | 'deleted' | 'expired'
const views: View[] = ['tree', 'list', 'deleted', 'expired']
const viewItems: TabsItem[] = [
  { label: '目录', value: 'tree' },
  { label: '列表', value: 'list' },
  { label: '已过期', value: 'expired' },
  { label: '已删除', value: 'deleted' },
]
const view = computed<View>(() => views.find((v) => v === route.query.view) ?? 'tree')
function setView(value: string | number) {
  void router.replace(withQuery({ view: value === 'tree' ? null : String(value) }))
}

// 窄柱的条数、根的条数和列表上方的总数都来自概览的统计，和概览页共用一份缓存。这个接口要把整个概览算一遍，
// 不跟着每次写入重取：写入时只标记过期（invalidateLists），别的页面进来时才取；这里在统计可能变了时取一次
const overview = useQuery({
  queryKey: computed(() => ['overview', spaceId.value]),
  queryFn: () => api.overview(spaceId.value),
  staleTime: 60_000,
})
// 疑似明文的条数也可能跟着变，导航上的角标一起刷新
function refreshCounts() {
  void overview.refetch()
  void invalidateInboxCounts(queryClient, spaceId.value)
}
// 窄柱上有来自对话的两类，所以算上它们；列表只列记忆，它的总数不算（见 MemoryListView）
const stackCounts = computed(() => {
  const data = overview.data.value
  return data ? tallyCounts([...data.counts, ...data.extractedCounts]) : null
})

// 窄柱按归属筛选：目录是懒加载的，筛不了，所以筛选都落在列表上。切到别的视图时列表的条件留在地址里，窄柱不亮
const filterLayer = computed(() => {
  const layer = route.query.layer as Layer
  return view.value === 'list' && LAYERS.includes(layer) ? layer : null
})
const filterSensitivity = computed(() => {
  const sensitivity = route.query.sensitivity as Sensitivity
  return view.value === 'list' && SENSITIVITIES.includes(sensitivity) ? sensitivity : null
})
// 再点同一类取消；换一类时敏感级的筛选不带过去，那一类可能一条都没有
function selectLayer(layer: Layer) {
  const same = filterLayer.value === layer
  void router.replace(
    withQuery({
      view: 'list',
      layer: same ? null : layer,
      sensitivity: same ? filterSensitivity.value : null,
    }),
  )
}
function clearStrataFilter() {
  void router.replace(withQuery({ layer: null, sensitivity: null }))
}
// 当前记忆在哪一类归属，窄柱上标出来。读完才知道，由编辑器告诉这里；选中的是根、人格或应用时就是它
const currentLayer = ref<Layer | null>(null)
watch(selectedUri, () => (currentLayer.value = null))
const markedLayer = computed<Layer | null>(() => {
  const node = nodeRef.value
  if (!node) return currentLayer.value
  return node.kind === 'root' ? node.layer : node.kind
})
// 悬停的那一行属于哪一类，窄柱上跟着亮。列表和目录一个委托够了，行再多也只有这一个监听
const nearLayer = ref<Layer | null>(null)
function onIndexHover(event: MouseEvent) {
  const row = (event.target as Element).closest?.('[data-layer]')
  nearLayer.value = (row?.getAttribute('data-layer') as Layer | undefined) ?? null
}

// 人格与应用的列表：人格、应用的根下面那一层，也用来把地址里的 persona:<id>、app:<id> 换成目录里的那一行
const personas = useQuery({
  queryKey: computed(() => ['personas', spaceId.value]),
  queryFn: () => api.personas(spaceId.value),
})
const nodeKey = computed(() =>
  nodeRef.value ? nodeKeyOf(nodeRef.value, personas.data.value, apps.data.value) : null,
)
// 目录里选中的那一行的键
const selectedKey = computed(() => selectedUri.value ?? nodeKey.value)

// 四个根默认展开：第一眼看到本人与通用的第一级、各个应用与人格
const DEFAULT_EXPANDED: readonly string[] = CURATED_STACK
const roots = ref<MemoryTreeItem[]>([])
// 展开的节点由这里管理：重新载入某一级之后，要据此把展开着的子节点也重新加载
const expanded = ref<string[]>([...DEFAULT_EXPANDED])
const loadingRoots = ref(false)
// 根的下一级没读出来：和「暂无记忆」分开说，免得以为记忆没了。记下错误，说法和别处一样用 readFailure
const rootsError = shallowRef<unknown>(null)
const createOpen = ref(false)
// 新建从目录里哪一行出发：带出归属与位置（见 draftFromKey）
const createFrom = ref('')

// 刚删掉的那条：目录和列表马上就要去掉它，窄屏返回时焦点不放回那一行
let deletedUri: string | null = null

function failed(err: unknown) {
  toast.add({ title: readFailure(err), color: 'error' })
}

// 列表、已删除、已过期、列表的位置选项与关键词索引都按查询缓存；树按需加载，由下面的函数单独刷新。
// 概览只标记过期，见 refreshCounts
function invalidateLists() {
  for (const key of [
    'memory-list',
    'memory-deleted',
    'memory-expired',
    'memory-children',
    'memory-glossary',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key, spaceId.value] })
  }
  void queryClient.invalidateQueries({
    queryKey: ['overview', spaceId.value],
    refetchType: 'none',
  })
}

// 四个根是固定的，展开着的根再去读下一级。某个根读失败时在上面报错，读到的照常显示
async function loadRoots() {
  loadingRoots.value = true
  // 切换空间时上一次请求可能后到，结果属于别的空间就丢掉
  const forSpace = spaceId.value
  roots.value = rootItems(CURATED_STACK)
  try {
    const rootError = await restoreExpanded()
    if (forSpace !== spaceId.value) return
    rootsError.value = rootError
    if (rootError) failed(rootError)
  } finally {
    loadingRoots.value = false
  }
}

// 人格与应用的根下面是各个人格、应用；别的行下面是坐标的下一级。人格、应用的列表每次都重读：
// 增删人格之后紧接着刷新这一层，缓存里可能还是旧的。人格、应用的坐标开头下面还没有记忆时，接口返回空的一级
async function loadChildren(item: MemoryTreeItem) {
  const forSpace = spaceId.value
  let children: MemoryTreeItem[]
  if (item.kind === 'root' && (item.uri === 'persona' || item.uri === 'app')) {
    const layer = item.uri
    const list =
      layer === 'persona'
        ? await queryClient.fetchQuery({
            queryKey: ['personas', forSpace],
            queryFn: () => api.personas(forSpace),
            staleTime: 0,
          })
        : await queryClient.fetchQuery({
            queryKey: ['apps', forSpace],
            queryFn: () => api.apps(forSpace),
            staleTime: 0,
          })
    children = entityItems(layer, list)
  } else {
    children = toTreeItems(await api.memoryChildren(forSpace, item.uri))
  }
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
// 只去掉不存在的，加载期间用户自己展开或收起的不受影响。根读失败时把错误交给调用方
async function restoreExpanded(): Promise<unknown> {
  const dropped = new Set<string>()
  let rootError: unknown = null
  for (const key of [...expanded.value].sort((a, b) => depthOf(a) - depthOf(b))) {
    const item = find(roots.value, key)
    if (!item?.children) {
      // 根一直在：没有下一级时只是收起来，下次有了再展开
      if (item?.kind !== 'root') dropped.add(key)
      continue
    }
    if (!item.loaded) {
      try {
        await loadChildren(item)
      } catch (err) {
        if (item.kind === 'root') rootError ??= err
        else dropped.add(key)
      }
    }
  }
  if (dropped.size) expanded.value = expanded.value.filter((key) => !dropped.has(key))
  return rootError
}

// 展开到某一行，例如打开带 ?uri= 或 ?node= 的链接、从列表或搜索里选中、新建之后
async function reveal(key: string) {
  expanded.value = [...new Set([...expanded.value, ...ancestorsOf(key)])]
  await restoreExpanded()
  await nextTick()
  scrollToRow(key)
}

// 新建、删除或移动之后刷新受影响的那一级。上一级被删空、成了不存在的虚拟节点时接口返回 404，再往上一级刷新
async function refreshAround(uri: string) {
  for (let key = parentOf(uri); ; key = parentOf(key)) {
    const parent = find(roots.value, key)
    if (!parent) return loadRoots()
    try {
      await loadChildren(parent)
      return restoreExpanded()
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404 || !key.includes('://')) throw err
    }
  }
}

// 人格或应用增删改名之后，那个根下面的一层重读
async function refreshRoot(layer: 'persona' | 'app') {
  const root = find(roots.value, layer)
  if (!root) return loadRoots()
  root.children ??= []
  await loadChildren(root)
  await restoreExpanded()
}

// 树的加载一次只跑一个：几次重载同时进行时，后面的会对着只载入一半的树判断哪些展开的节点已经不在了，
// 把还在的节点收起来。只在事件处理里排队，上面的函数互相调用时不再排队，否则会等自己。
// 新建、移动、撤销删除之后先把刷新排进去再切到那一条：对 selectedKey 的监听把展开排在刷新后面，
// 对着刷新过的树展开到新的位置；切过去也不用等树加载完
let treeTask: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = treeTask.then(task, task)
  treeTask = run.catch(() => undefined)
  return run
}

// 某个坐标上的记忆没了或换了一条（删除、移走、新建）：清掉它的缓存，再打开时重新读取
function resetMemory(uri: string) {
  void queryClient.resetQueries({ queryKey: ['memory', spaceId.value, uri], exact: true })
}

function refresh() {
  invalidateLists()
  refreshCounts()
  void queryClient.invalidateQueries({ queryKey: ['personas', spaceId.value] })
  void queryClient.invalidateQueries({ queryKey: ['apps', spaceId.value] })
  void serially(loadRoots)
}
// 根的下一级不是查询，照查询的形状交给 ReadFailureNote：错误、是否在读、重读
const rootsRead: ReadState = {
  data: computed(() => (roots.value.length ? roots.value : undefined)),
  error: rootsError,
  isFetching: loadingRoots,
  refetch: refresh,
}

// 这次点在箭头上。树的点击同时算选中和展开：点箭头只展开收起，点名字只打开
function clickedChevron(event: Event) {
  const original = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
  return !!(original.target as Element | null)?.closest?.('[data-chevron]')
}

async function onToggle(event: Event, item: MemoryTreeItem) {
  const original = (event as CustomEvent<{ originalEvent: Event }>).detail.originalEvent
  if (original.type === 'click' && selectable(item) && !clickedChevron(event)) {
    event.preventDefault()
    return
  }
  if (item.loaded) return
  try {
    await loadChildren(item)
  } catch (err) {
    failed(err)
  }
}

// 不让树自己记选中状态，选中只跟着地址走：切换被取消时高亮留在原处，点位置也不会高亮
function onSelect(event: Event, item: MemoryTreeItem) {
  event.preventDefault()
  if (!selectable(item) || clickedChevron(event)) return
  const node = nodeOfItem(item)
  void (node ? selectNode(node) : select(item.uri))
}

// 新建记忆：按选中的那一行带出归属与位置
function openCreate(key: string) {
  createFrom.value = key
  createOpen.value = true
}
// 工具栏上的「新建」：选中记忆时和它放在同一级，选中根、人格或应用时放在它下面
const toolbarCreateKey = computed(() => {
  if (selectedUri.value) return parentOf(selectedUri.value)
  return nodeKey.value ?? ''
})

async function onCreated(uri: string) {
  // 这个坐标上可能还留着之前删掉的那条的缓存
  resetMemory(uri)
  invalidateLists()
  refreshCounts()
  void serially(() => refreshAround(uri)).catch(failed)
  await select(uri)
}

async function onDeleted(uri: string) {
  deletedUri = uri
  await select(null)
  // 等编辑器卸载之后再清缓存，免得它重新读取一次、闪出「不存在」
  await nextTick()
  resetMemory(uri)
  invalidateLists()
  refreshCounts()
  await serially(() => refreshAround(uri)).catch(failed)
  deletedUri = null
}

// 保存、恢复之后，树上这一项的标题与标记跟着变。不知道改之前什么样时按变了算
function onChanged(memory: ConsoleMemoryView, before?: ConsoleMemoryView) {
  const item = find(roots.value, memory.uri)
  if (item) {
    Object.assign(item, {
      label: memory.title,
      layer: memory.layer,
      sensitivity: memory.sensitivity,
      priority: memory.priority,
    })
  }
  invalidateLists()
  if (!before || statsChanged(before, memory)) refreshCounts()
}

async function onMoved(memory: ConsoleMemoryView, from: string) {
  if (memory.uri === from) return onChanged(memory)
  invalidateLists()
  refreshCounts()
  void serially(async () => {
    await refreshAround(from).catch(failed)
    await refreshAround(memory.uri).catch(failed)
  })
  // 原来的坐标上已经没有这条记忆了：等原来的编辑器卸载后清掉它的缓存，退回去时重新读取。
  // 没切过去（导航被取消）时编辑器还在用它，不清
  if (!(await select(memory.uri))) {
    await nextTick()
    resetMemory(from)
  }
}

// 撤销删除或重新生效之后，这条记忆回到了树上：刷新那一级并选中它
async function onRevived(uri: string) {
  invalidateLists()
  refreshCounts()
  void serially(() => refreshAround(uri)).catch(failed)
  await select(uri)
}

// 正文里点了别的记忆的关键词：像链接一样跳过去，可以后退回来
function openLinked(uri: string) {
  void router.push(withQuery({ uri, node: null }))
}

// 人格的新建与修改：表单只有一个，放在这里，目录与右边的人格面板都用它
const personaForm = reactive({ open: false, editing: null as PersonaInfo | null })
function openPersonaForm(persona: PersonaInfo | null) {
  personaForm.editing = persona
  personaForm.open = true
}
function onPersonaSaved(persona: PersonaInfo, created: boolean) {
  void serially(() => refreshRoot('persona')).catch(failed)
  if (created) void selectNode(`persona:${persona.id}`)
}
function onPersonaRemoved() {
  void selectNode('persona')
  void serially(() => refreshRoot('persona')).catch(failed)
}

onMounted(() =>
  serially(async () => {
    await loadRoots()
    if (selectedKey.value) await reveal(selectedKey.value)
  }),
)
watch(spaceId, () => {
  // 上一个空间的目录不留：新空间读失败时错误下面不能是别的空间的树，展开它也会拿旧的节点去请求新空间
  roots.value = []
  rootsError.value = null
  expanded.value = [...DEFAULT_EXPANDED]
  // 新建窗口里的内容属于上一个空间，不能带到新空间去提交
  createOpen.value = false
  personaForm.open = false
  void serially(loadRoots)
})
// 从列表、搜索或正文的链接选中时，树也展开到那一行，切回树视图时看得到。
// 人格与应用要等列表读到才知道是哪一行，读到之后这里再展开
watch(selectedKey, (key) => {
  if (key) void serially(() => reveal(key))
})

// 树的选中状态跟着地址走：切换被取消（例如有未保存的修改）时，高亮也留在原来的节点
const selectedItem = computed(() =>
  selectedKey.value ? find(roots.value, selectedKey.value) : undefined,
)

// 目录一行多高：窄屏和触屏要点得准，高一些。虚拟滚动按这个高度算位置，要和样式一致
const viewport = useViewport()
const narrow = computed(() => viewport.value.width < 1024)
const coarsePointer = window.matchMedia('(pointer: coarse)').matches
const rowHeight = computed(() => (narrow.value || coarsePointer ? 36 : 28))
// 展开着的每一行在哪里：引线和滚动到选中的那一行都要用
const places = computed(() => treeRowPlaces(roots.value, expanded.value))
const treeRef = ref<{ $el: HTMLElement } | null>(null)
function scrollToRow(uri: string | null) {
  const el = treeRef.value?.$el
  if (!el) return
  const place = uri ? places.value.get(uri) : undefined
  if (place) {
    const top = place.index * rowHeight.value
    if (top < el.scrollTop || top + rowHeight.value > el.scrollTop + el.clientHeight) {
      el.scrollTop = top - el.clientHeight / 2
    }
  }
  // 目录刚从隐藏变成显示时，位置变了也不发 scroll 事件，虚拟滚动不知道，替它发一个
  el.dispatchEvent(new Event('scroll'))
}
// 这一栏从隐藏变成显示（窄屏返回、转屏）：虚拟滚动记的位置过期了，不告诉它目录就是一片空白。
// 粗指针设备转屏时行高不变，树不会重建，只能靠这里
const hasSelection = computed(() => Boolean(selectedUri.value || selectedNode.value))
const indexVisible = computed(() => !narrow.value || !hasSelection.value)
watch(indexVisible, async (visible) => {
  if (!visible) return
  await nextTick()
  scrollToRow(selectedKey.value)
})
// 滚到这一行并把焦点给它。行是虚拟滚动渲染的，滚动之后要等几帧才出来；一直没出来时调用 missing。
// 新的调用让还在等的作废，不然快速打字时旧的那一行出来后会抢走焦点
let focusWait = 0
function focusTreeRow(uri: string, missing?: () => void) {
  cancelAnimationFrame(focusWait)
  scrollToRow(uri)
  const attempt = (left: number) => {
    focusWait = requestAnimationFrame(() => {
      const row = treeRef.value?.$el.querySelector<HTMLElement>(`[data-uri="${CSS.escape(uri)}"]`)
      if (row) row.focus()
      else if (left > 0) attempt(left - 1)
      else missing?.()
    })
  }
  attempt(10)
}
// 带修饰键的方向键和字母是浏览器和系统的快捷键（Alt+← 后退、Cmd+←），放行
const hasModifier = (event: KeyboardEvent) => event.altKey || event.metaKey || event.ctrlKey
// 左键跳到上一级：组件库只在渲染出来的行里找，虚拟滚动下上一级可能不在。在它之前接过来，一律自己跳
function onTreeLeftKey(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' || hasModifier(event)) return
  const uri = (event.target as HTMLElement).dataset.uri
  const parent = uri ? parentRow(places.value, expanded.value, uri) : null
  if (!parent) return
  event.preventDefault()
  event.stopPropagation()
  focusTreeRow(parent)
}
// 打字跳到名字以这些字开头的那一行。组件库自带的跳转在虚拟滚动下把焦点给了外层的 li，
// 焦点就丢了，所以自己做，给它的文字留空（treeVirtualize）
let typed = ''
let typedAt = 0
function onTreeKeydown(event: KeyboardEvent) {
  if (event.key.length !== 1 || event.key === ' ' || hasModifier(event)) return
  typed = event.timeStamp - typedAt < 1000 ? typed + event.key : event.key
  typedAt = event.timeStamp
  const current = (document.activeElement as HTMLElement | null)?.dataset.uri ?? null
  const uri = typeaheadMatch(places.value, typed, current)
  if (uri) focusTreeRow(uri)
}
// textContent 不在组件库声明的选项里，但会一路传给虚拟滚动
const treeVirtualize = computed(() => ({
  estimateSize: rowHeight.value,
  overscan: 16,
  textContent: () => '',
}))
// 切回目录时树是新建的，滚动位置从头开始
watch(view, async (next) => {
  if (next !== 'tree' || !selectedKey.value) return
  await nextTick()
  scrollToRow(selectedKey.value)
})
// 窄屏切换之后的焦点（见 focusAfterSelect）。原来那一行不在了（筛选换了、刚删掉）时放到当前的标签上
const editorRef = ref<{ focusTitle: () => void } | null>(null)
const indexColumn = ref<HTMLElement | null>(null)
function focusIndexRow(uri: string) {
  const fallback = () =>
    indexColumn.value?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  if (uri === deletedUri) return fallback()
  if (view.value === 'tree') return focusTreeRow(uri, fallback)
  const row = listScroller.value?.querySelector<HTMLElement>(
    `button[data-uri="${CSS.escape(uri)}"]`,
  )
  if (!row) return fallback()
  row.scrollIntoView({ block: 'center' })
  row.focus({ preventScroll: true })
}
watch(selectedKey, async (uri, previous) => {
  const target = focusAfterSelect(narrow.value, uri, previous)
  if (!target) return
  await nextTick()
  if (target.to === 'title') editorRef.value?.focusTitle()
  else focusIndexRow(target.uri)
})
// 三个列表共用一个滚动区：各记各的位置，切回来还在原处
const listScroller = ref<HTMLElement | null>(null)
const listScrollTops = new Map<View, number>()
watch(
  view,
  async (next, previous) => {
    if (listScroller.value) listScrollTops.set(previous, listScroller.value.scrollTop)
    await nextTick()
    if (listScroller.value) listScroller.value.scrollTop = listScrollTops.get(next) ?? 0
  },
  { flush: 'pre' },
)

// 行尾的数字：根是这一类记忆的条数（来自概览的统计），收起的行是下一级有几个
function rowCount(item: MemoryTreeItem, open: boolean) {
  if (item.kind === 'root') {
    return stackCounts.value && item.layer ? layerTotal(stackCounts.value, item.layer) : null
  }
  if (!item.children) return null
  return open ? null : (item.count ?? null)
}

// 根的名字：树还没读到时也说中文
const rootLabel = (key: string) => (key in layerLabels ? layerLabels[key as Layer] : key)

// 详情上方的路径：根、人格或应用与各级位置。本身能打开的（根、人格、应用、有记忆的上一级）可以点过去
const crumbs = computed(() => {
  const uri = selectedUri.value
  if (!uri) return []
  return ancestorsOf(uri).map((key) => {
    const item = find(roots.value, key)
    const label = item?.label ?? (key.includes('://') ? lastSegment(key) : rootLabel(key))
    if (!item || !selectable(item)) return { label }
    const node = nodeOfItem(item)
    return { label, to: withQuery(node ? { node, uri: null } : { uri: key, node: null }) }
  })
})
</script>

<template>
  <!-- 窄屏放不下多栏：选中记忆、根、人格或应用时只显示右边，返回后再显示目录 -->
  <div class="memories" :class="{ 'has-selection': hasSelection }">
    <aside class="ribbon-column">
      <StrataRibbon
        :counts="stackCounts"
        :selected="filterLayer"
        :sensitivity="filterSensitivity"
        :current="markedLayer"
        :near="nearLayer"
        @select="selectLayer"
        @clear="clearStrataFilter"
      />
    </aside>

    <section
      ref="indexColumn"
      class="index-column"
      aria-label="记忆"
      @mouseover="onIndexHover"
      @mouseleave="nearLayer = null"
    >
      <div class="index-head">
        <UTabs
          :model-value="view"
          :items="viewItems"
          :content="false"
          variant="link"
          size="md"
          :ui="{ root: 'min-w-0', list: 'border-0', trigger: 'px-2 py-0 h-11 text-sm/5' }"
          @update:model-value="setView"
        />
        <div class="flex shrink-0 items-center gap-1">
          <UButton
            :icon="icons.refresh"
            size="sm"
            color="neutral"
            variant="ghost"
            aria-label="刷新"
            @click="refresh"
          />
          <UButton
            v-if="canWrite"
            size="sm"
            color="primary"
            variant="outline"
            @click="openCreate(toolbarCreateKey)"
          >
            新建
          </UButton>
        </div>
      </div>
      <div class="ribbon-flat">
        <StrataRibbon
          orientation="horizontal"
          :counts="stackCounts"
          :selected="filterLayer"
          :sensitivity="filterSensitivity"
          @select="selectLayer"
          @clear="clearStrataFilter"
        />
      </div>

      <template v-if="view === 'tree'">
        <p v-if="overview.data.value" class="index-count">
          <b>{{ overview.data.value.total }}</b> 条
        </p>
        <!-- 重读失败时已经读到的目录留着，展开的节点也不丢：错误放在上面 -->
        <div v-if="rootsError !== null" class="index-note">
          <ReadFailureNote :query="rootsRead" />
        </div>
        <!-- 一级最多五百行，展开几级就是几千行：只渲染看得见的那些。行高固定，虚拟滚动不用量 -->
        <UTree
          v-if="roots.length"
          ref="treeRef"
          :key="rowHeight"
          v-model:expanded="expanded"
          class="memory-tree"
          aria-label="记忆目录"
          :model-value="selectedItem"
          :items="roots"
          :get-key="(item) => item.uri"
          :virtualize="treeVirtualize"
          @toggle="onToggle"
          @select="onSelect"
          @keydown="onTreeKeydown"
          @keydown.capture="onTreeLeftKey"
        >
          <template #item-wrapper="{ item, expanded: open, selected }">
            <div
              class="tree-row"
              :class="{
                selected,
                virtual: item.kind === 'folder',
                root: item.kind === 'root',
                entity: item.kind === 'entity',
                note: item.disabled,
              }"
              :style="{
                height: `${rowHeight}px`,
                paddingLeft: `${5 + (places.get(item.uri)?.depth ?? 0) * 16}px`,
              }"
              :data-layer="item.layer ?? undefined"
              :data-uri="item.uri"
              :title="item.kind === 'folder' ? '这一级没有记忆，只能展开' : undefined"
            >
              <template v-if="places.get(item.uri)">
                <template v-for="line in guideLines(places.get(item.uri)!)" :key="line.left">
                  <i class="guide" :class="{ end: line.end }" :style="{ left: `${line.left}px` }" />
                  <i v-if="line.tick" class="tick" :style="{ left: `${line.left}px` }" />
                </template>
              </template>
              <span
                v-if="item.children"
                class="chevron"
                :class="{ open }"
                data-chevron
                aria-hidden="true"
              >
                <svg width="8" height="8" viewBox="0 0 8 8">
                  <path d="M2 1l4 3-4 3z" fill="currentColor" />
                </svg>
              </span>
              <span v-else class="chevron" />
              <StrataSwatch
                v-if="item.kind === 'root' && item.layer"
                class="me-[7px] shrink-0"
                :layer="item.layer"
                plain
                decorative
              />
              <StrataSwatch
                v-else-if="item.exists && item.layer && item.sensitivity"
                class="me-[7px] shrink-0"
                :layer="item.layer"
                :sensitivity="item.sensitivity"
              />
              <span class="tree-label" :class="{ mono: item.kind === 'folder' }">{{
                item.label
              }}</span>
              <span v-if="item.meta" class="tree-meta">{{ item.meta }}</span>
              <span class="tree-trail">
                <MemoryFlags
                  v-if="item.exists"
                  :sensitivity="item.sensitivity"
                  :priority="item.priority"
                />
                <span v-if="rowCount(item, open) !== null" class="tree-count">
                  {{ rowCount(item, open) }}
                </span>
              </span>
            </div>
          </template>
        </UTree>
      </template>
      <!-- 列表、已删除与已过期切走时不卸载：保留筛选与位置，切走之前发出的撤销删除、重新生效完成后也还能通知到这里。
           所以外面这一层切到目录时也只是藏起来 -->
      <div v-show="view !== 'tree'" ref="listScroller" class="index-scroll">
        <KeepAlive>
          <MemoryListView
            v-if="view === 'list'"
            :space-id="spaceId"
            :selected-uri="selectedUri"
            :overview="overview.data.value"
            @select="select"
          />
          <DeletedMemories
            v-else-if="view === 'deleted'"
            :space-id="spaceId"
            @restored="onRevived"
            @show-expired="setView('expired')"
          />
          <ExpiredMemories
            v-else-if="view === 'expired'"
            :space-id="spaceId"
            @reactivated="onRevived"
          />
        </KeepAlive>
      </div>
    </section>

    <section class="detail-column" aria-label="详情">
      <MemoryEditor
        v-if="selectedUri"
        :key="`${spaceId}|${selectedUri}`"
        ref="editorRef"
        :space-id="spaceId"
        :uri="selectedUri"
        @deleted="onDeleted"
        @create-child="openCreate"
        @changed="onChanged"
        @moved="onMoved"
        @open="openLinked"
        @layer="currentLayer = $event"
      >
        <template #nav>
          <button type="button" class="back" @click="select(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
          <nav class="crumbs" aria-label="位置">
            <template v-for="(crumb, index) in crumbs" :key="index">
              <i v-if="index > 0" class="crumb-sep" aria-hidden="true">›</i>
              <RouterLink v-if="crumb.to" :to="crumb.to" class="crumb-link">
                {{ crumb.label }}
              </RouterLink>
              <span v-else>{{ crumb.label }}</span>
            </template>
          </nav>
        </template>
      </MemoryEditor>
      <MemoryRootPanel
        v-else-if="nodeRef?.kind === 'root'"
        :key="`${spaceId}|${nodeRef.layer}`"
        ref="editorRef"
        :space-id="spaceId"
        :layer="nodeRef.layer"
        :counts="stackCounts"
        :can-write="canWrite"
        :can-edit-personas="canEditPersonas"
        @create="openCreate(nodeRef.layer)"
        @create-persona="openPersonaForm(null)"
        @open-persona="(id) => selectNode(`persona:${id}`)"
        @open-app="(id) => selectNode(`app:${id}`)"
      >
        <template #nav>
          <button type="button" class="back" @click="selectNode(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
        </template>
      </MemoryRootPanel>
      <PersonaPanel
        v-else-if="nodeRef?.kind === 'persona'"
        :key="`${spaceId}|${nodeRef.id}`"
        ref="editorRef"
        :space-id="spaceId"
        :persona-id="nodeRef.id"
        :can-edit="canEditPersonas"
        :can-write="canWrite"
        @edit="openPersonaForm"
        @removed="onPersonaRemoved"
        @create="openCreate(nodeKey ?? 'persona')"
        @open="(id) => selectNode(`persona:${id}`)"
        @open-app="(id) => selectNode(`app:${id}`)"
      >
        <template #nav>
          <button type="button" class="back" @click="selectNode(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
          <nav class="crumbs" aria-label="位置">
            <RouterLink :to="withQuery({ node: 'persona', uri: null })" class="crumb-link">
              人格
            </RouterLink>
          </nav>
        </template>
      </PersonaPanel>
      <AppPanel
        v-else-if="nodeRef?.kind === 'app'"
        :key="`${spaceId}|${nodeRef.id}`"
        ref="editorRef"
        :space-id="spaceId"
        :app-id="nodeRef.id"
        :can-write="canWrite"
        @create="openCreate(nodeKey ?? 'app')"
        @open-persona="(id) => selectNode(`persona:${id}`)"
      >
        <template #nav>
          <button type="button" class="back" @click="selectNode(null)">
            <UIcon :name="icons.back" class="size-4" />
            返回
          </button>
          <nav class="crumbs" aria-label="位置">
            <RouterLink :to="withQuery({ node: 'app', uri: null })" class="crumb-link">
              应用
            </RouterLink>
          </nav>
        </template>
      </AppPanel>
      <p v-else class="detail-empty">
        选择一条记忆<Hint
          >目录中没有记忆的位置只能展开；选中本人、应用、人格、通用或某个人格、应用时，右边是它的设置与记忆。</Hint
        >
      </p>
    </section>

    <CreateMemoryModal
      v-model:open="createOpen"
      :space-id="spaceId"
      :from="createFrom"
      @created="onCreated"
    />
    <PersonaFormModal
      v-model:open="personaForm.open"
      :space-id="spaceId"
      :personas="personas.data.value ?? []"
      :editing="personaForm.editing"
      @saved="onPersonaSaved"
    />
  </div>
</template>

<style scoped>
.memories {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 80px 344px minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
}
.ribbon-column {
  min-height: 0;
  padding-bottom: 14px;
  border-right: 1px solid var(--strata-rule);
  overflow: hidden;
}
.index-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--strata-rule);
}
.index-head {
  flex: none;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 4px;
  height: 44px;
  padding: 0 10px 0 6px;
  border-bottom: 1px solid var(--strata-rule);
}
.index-head > div:last-child {
  align-self: center;
}
/* 横排的窄柱只在窄屏出现，竖排的在窄屏藏起来 */
.ribbon-flat {
  display: none;
  flex: none;
  padding: 10px 16px 0;
}
.index-count {
  flex: none;
  padding: 7px 14px;
  border-bottom: 1px solid var(--ui-border);
  font-size: 14px;
  line-height: 1.55;
}
.index-count b {
  font-family: var(--font-mono);
  font-weight: 600;
}
.index-note {
  padding: 14px 14px 0;
}
.index-empty {
  padding: 18px 14px;
  color: var(--ui-text-muted);
}
.index-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 切回来时位置由上面的监听恢复，浏览器的滚动锚定会再挪一点 */
  overflow-anchor: none;
}
/* 根元素在组件库里面，要穿透 */
.index-column :deep(.memory-tree) {
  flex: 1;
  min-height: 0;
  padding: 5px 0 16px;
  /* 路径最深十六级，缩进加上标记可能比这一栏宽 */
  overflow-x: hidden;
}
.tree-row {
  position: relative;
  display: flex;
  align-items: center;
  padding-right: 12px;
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.tree-row.note {
  cursor: default;
}
.tree-row:not(.note):hover {
  background: var(--ui-bg-elevated);
}
.tree-row:focus-visible {
  outline-offset: -2px;
}
.tree-row.virtual {
  color: var(--ui-text-muted);
}
.tree-row.virtual:hover {
  color: var(--ui-text-highlighted);
}
.tree-row.root,
.tree-row.entity {
  color: var(--ui-text);
  font-weight: 500;
}
.tree-row.note {
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--ui-text-muted);
}
/* 选中的行写在各类行的后面：选择器的优先级相同，后写的才压得住。写在前面时根、人格与应用的名字
   取 --ui-text，鼠标移开之后和选中的底色一样深，看不见 */
.tree-row.selected,
.tree-row.selected:hover {
  --strata-frame: var(--strata-selected-frame);
  --flag-muted: var(--strata-on-selected-muted);
  --flag-solid: var(--strata-on-selected);
  --flag-on-solid: var(--strata-selected);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-border-accented);
}
.guide.end {
  bottom: 50%;
}
.tick {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 1px;
  background: var(--ui-border-accented);
}
.tree-row.selected .guide,
.tree-row.selected .tick {
  background: var(--strata-on-selected-muted);
}
.chevron {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  align-self: stretch;
  margin-right: 3px;
  color: var(--ui-text-muted);
}
.chevron:hover {
  color: var(--ui-text-highlighted);
}
.chevron svg {
  transition: transform 0.1s linear;
}
/* 触屏上箭头的热区放大到 32px：这一列加宽，把色块和名字往右推，不盖到它们。箭头的位置不变，还和引线对得上。行高这时是 36px */
@media (pointer: coarse) {
  .chevron {
    justify-content: flex-start;
    width: 27px;
    padding-left: 5px;
  }
  .chevron::before {
    content: '';
    position: absolute;
    inset: 0 0 0 -5px;
  }
}
.chevron.open svg {
  transform: rotate(90deg);
}
.tree-row.selected .chevron {
  color: var(--strata-on-selected);
}
.tree-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 位置是坐标里的一段，用等宽字；记忆写标题，人格与应用写名字 */
.tree-label.mono {
  font-family: var(--font-mono);
}
.tree-meta {
  flex: none;
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--ui-text-muted);
}
.tree-row.selected .tree-meta {
  color: var(--strata-on-selected-muted);
}
.tree-trail {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding-left: 8px;
  font-family: var(--font-sans);
}
.tree-count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ui-text-muted);
}
.tree-row.selected .tree-count {
  color: var(--strata-on-selected-muted);
}
.detail-column {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.detail-empty {
  padding: 32px;
  color: var(--ui-text-muted);
}
/* 返回只在窄屏有：宽屏上目录一直在旁边 */
.back {
  display: none;
  align-items: center;
  gap: 3px;
  height: 32px;
  margin: -4px 0 4px -3px;
  font-size: 14px;
  color: var(--ui-text-muted);
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}
.crumb-sep {
  font-family: var(--font-sans);
}
.crumb-link:hover {
  color: var(--ui-text-highlighted);
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 1240px) {
  .memories {
    grid-template-columns: 80px 324px minmax(0, 1fr);
  }
}
@media (max-width: 1023.98px) {
  .memories {
    grid-template-columns: minmax(0, 1fr);
  }
  .ribbon-column {
    display: none;
  }
  .ribbon-flat {
    display: block;
  }
  .back {
    display: inline-flex;
  }
  .index-column {
    border-right: 0;
  }
  .has-selection .index-column,
  .memories:not(.has-selection) .detail-column {
    display: none;
  }
  .index-head {
    padding: 0 16px 0 7px;
  }
  .index-count,
  .index-empty {
    padding-left: 16px;
    padding-right: 16px;
  }
  .detail-empty {
    padding: 16px;
  }
}
</style>
