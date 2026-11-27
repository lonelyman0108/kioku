import { effectiveBootMode, type EntryListItem } from '@kioku/contracts'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { entryKindLabels } from '../labels'
import { captureRoute, createEntryRoute, entryRoute, settingsRoute } from '../routes'

const SEARCH_DELAY_MS = 250

const SETTINGS_SUBPAGES: CommandPaletteItem[] = [
  { label: '设置 · 连接与终端', icon: icons.keys, to: settingsRoute('keys') },
  { label: '设置 · 模型', icon: icons.models, to: settingsRoute('models') },
  { label: '设置 · 账号与数据', icon: icons.account, to: settingsRoute('account') },
]

function entrySearchIcon(entry: EntryListItem): string {
  if (entry.kind === 'episode') return icons.messageSquare
  const mode = effectiveBootMode(entry)
  if (mode === 'index') return icons.bookmark
  if (mode === 'full') return icons.pin
  return icons.bookOpen
}

// ⌘K 搜索：页面跳转由搜索框本地过滤，词条经服务端混合检索返回
export function useConsoleSearch(pages: Ref<CommandPaletteItem[]>) {
  const route = useRoute()
  const term = ref('')
  const loading = ref(false)
  const items = ref<EntryListItem[] | null>(null)
  const failure = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  watch(term, (value) => {
    clearTimeout(timer)
    const query = value.trim()
    const mine = ++seq
    failure.value = null
    if (!query) {
      items.value = null
      loading.value = false
      return
    }
    loading.value = true
    timer = setTimeout(async () => {
      try {
        const res = await api.entries({ q: query, mode: 'lookup', limit: 15 })
        if (mine === seq) items.value = res.items
      } catch (err) {
        if (mine !== seq) return
        items.value = null
        failure.value = err instanceof ApiError ? err.message : '搜索失败，请重试'
      } finally {
        if (mine === seq) loading.value = false
      }
    }, SEARCH_DELAY_MS)
  })
  onBeforeUnmount(() => clearTimeout(timer))

  const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
    const query = term.value.trim()
    const baseQuery = route.name === 'memories' ? route.query : undefined
    const list: CommandPaletteGroup<CommandPaletteItem>[] = [
      {
        id: 'capture',
        label: '快捷操作',
        ignoreFilter: true,
        items: [
          {
            label: query ? `随手记：${query}` : '随手记',
            suffix: query ? '归并至对应记忆' : '记录习惯、约定或事实更新',
            icon: icons.capture,
            to: captureRoute(query, baseQuery),
          },
          {
            label: '新建记忆',
            suffix: '直接起草一条新记忆',
            icon: icons.add,
            to: createEntryRoute(baseQuery),
          },
        ],
      },
      { id: 'pages', label: '页面', items: [...pages.value, ...SETTINGS_SUBPAGES] },
    ]
    if (failure.value) {
      list.push({
        id: 'error',
        label: '搜索失败',
        ignoreFilter: true,
        items: [{ label: failure.value, icon: icons.error, disabled: true }],
      })
    }
    if (!items.value) return list
    list.push({
      id: 'entries',
      label: '记忆',
      ignoreFilter: true,
      items: items.value.map((entry) => ({
        label: entry.title,
        suffix: entry.disclosure ?? `${entry.shortId} · ${entryKindLabels[entry.kind]}`,
        icon: entrySearchIcon(entry),
        to: entryRoute(entry.shortId),
      })),
    })
    return list
  })

  return { term, loading, groups }
}
