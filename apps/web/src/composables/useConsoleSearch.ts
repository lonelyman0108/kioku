import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { CircleSummary, ConsoleSearchResponse, EntryKind } from '@kioku/contracts'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { entryKindLabels } from '../labels'
import { entryRoute } from '../routes'

// 输入停下来这么久之后再去服务端搜，免得每敲一个字都请求一次
const SEARCH_DELAY_MS = 250

function itemIcon(kind: EntryKind, sensitivity?: string, recall = false): string {
  if (sensitivity === 'secret') return icons.secret
  if (kind === 'fact') return icons.user
  if (kind === 'episode') return icons.conversations
  return recall ? icons.memories : icons.file
}

// ⌘K 搜索：页面跳转由搜索框自己过滤；词条交给服务端跨全部加入圈检索，分成短 ID / 标题 / 召回说明直接命中、召回候选两组。
// 换了记忆圈或改了输入，之前发出的请求晚到也不采用
export function useConsoleSearch(
  circleId: Ref<string | null>,
  pages: Ref<CommandPaletteItem[]>,
  circles?: Ref<readonly Pick<CircleSummary, 'id' | 'name'>[]>,
) {
  const term = ref('')
  const loading = ref(false)
  const results = ref<ConsoleSearchResponse | null>(null)
  const failure = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  watch([term, circleId], ([value, id], previous) => {
    clearTimeout(timer)
    const query = value.trim()
    const mine = ++seq
    // 换了记忆圈：上一个记忆圈的结果立刻清掉，不能拿新记忆圈的地址去开它们
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
        const found = await api.searchEntries(id, query, { allCircles: true })
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

  const circleNames = computed(() => new Map((circles?.value ?? []).map((c) => [c.id, c.name])))

  const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
    const list: CommandPaletteGroup<CommandPaletteItem>[] = [
      { id: 'pages', label: '页面', items: pages.value },
    ]
    const id = circleId.value
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
    const suffixFor = (
      item: {
        shortId: string
        circleId: string
        circleSlug: string | null
        kind: EntryKind
      },
      extra: string | null | undefined,
    ) => {
      const circleTag =
        item.circleId !== id
          ? (circleNames.value.get(item.circleId) ?? item.circleSlug ?? '跨圈')
          : null
      return [item.shortId, entryKindLabels[item.kind], circleTag, extra]
        .filter(Boolean)
        .join(' · ')
    }
    const direct = new Set(found.matches.map((m) => `${m.circleId}:${m.shortId}`))
    // 服务端已经按查询词筛过，不再交给搜索框按文字过滤
    list.push(
      {
        id: 'matches',
        label: '标题、短 ID 与召回说明',
        ignoreFilter: true,
        items: found.matches.map((m) => ({
          label: m.title,
          suffix: suffixFor(m, m.disclosure),
          icon: itemIcon(m.kind, m.sensitivity),
          to: entryRoute(m.circleId, m.shortId),
        })),
      },
      {
        id: 'recall',
        label: '召回',
        ignoreFilter: true,
        items: found.candidates
          .filter((c) => !direct.has(`${c.circleId}:${c.shortId}`))
          .map((c) => ({
            label: c.title,
            suffix: suffixFor(c, c.cues.length ? c.cues.join(' · ') : c.disclosure),
            icon: itemIcon(c.kind, undefined, true),
            to: entryRoute(c.circleId, c.shortId),
          })),
      },
    )
    return list
  })

  return { term, loading, groups }
}
