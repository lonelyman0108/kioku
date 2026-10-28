import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { ConsoleSearchResponse } from '@kioku/contracts'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { layerLabels } from '../labels'
import { memoryRoute } from '../routes'

// 输入停下来这么久之后再去服务端搜，免得每敲一个字都请求一次
const SEARCH_DELAY_MS = 250

// ⌘K 搜索：页面跳转由搜索框自己过滤；记忆交给服务端，分成 URI 与关键词的直接命中、召回候选两组。
// 换了空间或改了输入，之前发出的请求晚到也不采用
export function useConsoleSearch(spaceId: Ref<string | null>, pages: Ref<CommandPaletteItem[]>) {
  const term = ref('')
  const loading = ref(false)
  const results = ref<ConsoleSearchResponse | null>(null)
  const failure = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  watch([term, spaceId], ([value, id], previous) => {
    clearTimeout(timer)
    const query = value.trim()
    const mine = ++seq
    // 换了空间：上一个空间的结果立刻清掉，不能拿新空间的地址去开它们
    if (previous[1] !== undefined && id !== previous[1]) results.value = null
    failure.value = null
    if (!query || !id) {
      results.value = null
      loading.value = false
      return
    }
    loading.value = true
    timer = setTimeout(async () => {
      try {
        const found = await api.searchMemories(id, query)
        if (mine === seq) results.value = found
      } catch (err) {
        if (mine !== seq) return
        results.value = null
        failure.value = err instanceof ApiError ? err.message : '搜索失败，请重试'
      } finally {
        if (mine === seq) loading.value = false
      }
    }, SEARCH_DELAY_MS)
  })
  onBeforeUnmount(() => clearTimeout(timer))

  const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
    const list: CommandPaletteGroup<CommandPaletteItem>[] = [
      { id: 'pages', label: '页面', items: pages.value },
    ]
    const id = spaceId.value
    if (failure.value) {
      list.push({
        id: 'error',
        label: '搜索失败',
        ignoreFilter: true,
        items: [{ label: failure.value, icon: icons.error, disabled: true }],
      })
    }
    const found = results.value
    if (!id || !found) return list
    const to = (uri: string) => memoryRoute(id, uri)
    const direct = new Set(found.matches.map((m) => m.uri))
    // 服务端已经按查询词筛过，不再交给搜索框按文字过滤
    list.push(
      {
        id: 'matches',
        label: 'URI 与关键词',
        ignoreFilter: true,
        items: found.matches.map((m) => ({
          label: m.uri,
          suffix: m.disclosure ?? layerLabels[m.layer],
          icon: m.sensitivity === 'secret' ? icons.secret : icons.file,
          to: to(m.uri),
        })),
      },
      {
        id: 'recall',
        label: '召回',
        ignoreFilter: true,
        items: found.candidates
          .filter((c) => !direct.has(c.uri))
          .map((c) => ({
            label: c.uri,
            suffix: c.cues.length ? c.cues.join(' · ') : (c.disclosure ?? ''),
            icon: icons.memories,
            to: to(c.uri),
          })),
      },
    )
    return list
  })

  return { term, loading, groups }
}
