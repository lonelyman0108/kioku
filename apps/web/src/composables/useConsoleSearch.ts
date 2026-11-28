import {
  effectiveBootMode,
  type CredentialFieldMeta,
  type CredentialMeta,
  type EntryListItem,
} from '@kioku/contracts'
import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import { useQuery } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { icons } from '../icons'
import { bootModeLabels, entryKindLabels } from '../labels'
import {
  captureRoute,
  createEntryRoute,
  credentialRoute,
  entryRoute,
  newCredentialRoute,
  settingsRoute,
} from '../routes'
import { formatRelative } from '../time'

const SEARCH_DELAY_MS = 250
const CREDENTIAL_SEARCH_LIMIT = 10

export const SETTINGS_SUBPAGES: CommandPaletteItem[] = [
  { label: '设置 · 终端与密钥', icon: icons.terminal, to: settingsRoute('keys') },
  { label: '设置 · 嵌入与索引', icon: icons.database, to: settingsRoute('embed') },
  { label: '设置 · 对话与整理', icon: icons.sparkles, to: settingsRoute('chat') },
  { label: '设置 · 定时计划', icon: icons.clock, to: settingsRoute('schedule') },
  { label: '设置 · 账号与登录设备', icon: icons.account, to: settingsRoute('account') },
  { label: '设置 · 备份与迁移', icon: icons.archive, to: settingsRoute('transfer') },
  { label: '浏览器授权', icon: icons.shieldCheck, to: { name: 'authorize' } },
]

export interface CredentialSearchMatch {
  cred: CredentialMeta
  matchedField: CredentialFieldMeta | null
  score: number
}

// 仅基于凭据元数据本地匹配，绝不触发明文解密
export function matchCredentialsForSearch(
  credentials: readonly CredentialMeta[],
  rawQuery: string,
  limit = CREDENTIAL_SEARCH_LIMIT,
): CredentialSearchMatch[] {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return []

  const results: CredentialSearchMatch[] = []
  for (const cred of credentials) {
    const slugLower = cred.slug.toLowerCase()
    const labelLower = cred.label.toLowerCase()
    const descLower = (cred.description ?? '').toLowerCase()

    let matchedField: CredentialFieldMeta | null = null
    const hasHash = q.includes('#')
    for (const field of cred.fieldMeta) {
      const refText = `${slugLower}#${field.name.toLowerCase()}`
      const fieldNameLower = field.name.toLowerCase()
      const fieldLabelLower = (field.label ?? '').toLowerCase()
      if (
        (hasHash && refText.includes(q)) ||
        fieldNameLower.includes(q) ||
        (fieldLabelLower && fieldLabelLower.includes(q))
      ) {
        matchedField = field
        break
      }
    }

    let score = 0
    if (slugLower === q || labelLower === q) score = 100
    else if (slugLower.startsWith(q) || labelLower.startsWith(q)) score = 80
    else if (slugLower.includes(q) || labelLower.includes(q)) score = 60
    else if (matchedField) score = 50
    else if (descLower.includes(q)) score = 30

    if (score > 0) {
      results.push({ cred, matchedField, score })
    }
  }

  results.sort((a, b) => b.score - a.score || a.cred.slug.localeCompare(b.cred.slug))
  return results.slice(0, limit)
}

export function credentialSearchSuffix(match: CredentialSearchMatch): string {
  const { cred, matchedField } = match
  if (matchedField) {
    return matchedField.label
      ? `${cred.slug}#${matchedField.name} · ${matchedField.label}`
      : `${cred.slug}#${matchedField.name}`
  }
  return cred.description ? `${cred.slug} · ${cred.description}` : cred.slug
}

function entrySearchIcon(entry: EntryListItem): string {
  if (entry.kind === 'episode') return icons.messageSquare
  const mode = effectiveBootMode(entry)
  if (mode === 'index') return icons.bookmark
  if (mode === 'full') return icons.pin
  return icons.bookOpen
}

function entrySearchSuffix(entry: EntryListItem): string {
  if (entry.disclosure) return entry.disclosure
  const status =
    entry.kind === 'episode'
      ? entryKindLabels[entry.kind]
      : bootModeLabels[effectiveBootMode(entry)]
  return `${status} · ${formatRelative(entry.updatedAt)}`
}

// ⌘K 搜索：页面跳转与凭据元数据由本地过滤，记忆经服务端混合检索返回
export function useConsoleSearch(pages: Ref<CommandPaletteItem[]>) {
  const route = useRoute()
  const term = ref('')
  const loading = ref(false)
  const items = ref<EntryListItem[] | null>(null)
  const failure = ref<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0

  // 仅在输入关键词时按需复用凭据元数据缓存，绝不调用 reveal
  const credentialsQuery = useQuery({
    queryKey: ['credentials'] as const,
    queryFn: () => api.credentials(),
    enabled: computed(() => term.value.trim().length > 0),
    staleTime: 60_000,
  })

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

  const matchedCredentials = computed(() =>
    matchCredentialsForSearch(credentialsQuery.data.value?.items ?? [], term.value),
  )

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
          {
            label: '新建凭据',
            suffix: '新增一条加密托管凭据',
            icon: icons.credentials,
            to: newCredentialRoute(),
          },
        ],
      },
      { id: 'pages', label: '页面', items: [...pages.value, ...SETTINGS_SUBPAGES] },
    ]
    if (query && matchedCredentials.value.length > 0) {
      list.push({
        id: 'credentials',
        label: '凭据',
        ignoreFilter: true,
        items: matchedCredentials.value.map((match) => ({
          label: match.cred.label,
          suffix: credentialSearchSuffix(match),
          icon: icons.credentials,
          to: credentialRoute(match.cred.slug),
        })),
      })
    }
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
        suffix: entrySearchSuffix(entry),
        icon: entrySearchIcon(entry),
        to: entryRoute(entry.shortId),
      })),
    })
    return list
  })

  return { term, loading, groups }
}
