import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, ref, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import { ApiError } from '../api/client'
import credentialDetail from '../components/CredentialDetail.vue?raw'
import deletedMemories from '../components/DeletedMemories.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import expiredMemories from '../components/ExpiredMemories.vue?raw'
import inboxBindings from '../components/InboxBindings.vue?raw'
import inboxPlaintext from '../components/InboxPlaintext.vue?raw'
import inboxReview from '../components/InboxReview.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryListView from '../components/MemoryListView.vue?raw'
import personaDetail from '../components/PersonaDetail.vue?raw'
import ReadFailureNote from '../components/strata/ReadFailureNote.vue'
import readFailureNote from '../components/strata/ReadFailureNote.vue?raw'
import activityPage from '../pages/ActivityPage.vue?raw'
import appDetailPage from '../pages/AppDetailPage.vue?raw'
import appsPage from '../pages/AppsPage.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'
import personasPage from '../pages/PersonasPage.vue?raw'
import recallPage from '../pages/RecallPage.vue?raw'
import subjectDetailPage from '../pages/SubjectDetailPage.vue?raw'
import subjectsPage from '../pages/SubjectsPage.vue?raw'
import { failedReads, queryClient } from '../query'

// 读取失败的写法：一律用 ReadFailureNote。文字经 readFailure；再读有用时给「重试」，重读的就是传进去的那一样，
// 重读期间转圈。读到过内容的，内容照常显示，错误放在上面

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: { name: string; arg?: { content: string }; exp?: { content: string } }[]
}
const ELEMENT = 1
const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const notesOf = (source: string) =>
  elementsOf(template(source)).filter((el) => el.tag === 'ReadFailureNote')

// 一样读取：错误、是否在读、重读
const read = (error: unknown, isFetching = false) => ({
  error: ref(error),
  isError: ref(error !== null),
  isFetching: ref(isFetching),
  refetch: vi.fn(),
})

// 没有组件测试的环境，组件用服务端渲染成 HTML 来看
const render = (props: Record<string, unknown>) =>
  renderToString(createSSRApp({ render: () => h(ReadFailureNote as Component, props) }))
// 这一行的语气：NoteLine 的标题带着 error 或 warning
const toneOf = (html: string) => /<p class="([^"]*)"/.exec(html)![1]!.split(' ').sort().join(' ')
// 重试按钮：在读的时候转圈（Nuxt UI 的按钮转圈时带 animate-spin 的图标）
const retryButton = (html: string) =>
  /<button[^>]*>(?:(?!<\/button>)[^])*重试(?:(?!<\/button>)[^])*<\/button>/.exec(html)?.[0]

describe('ReadFailureNote', () => {
  it('服务端给了说明就写它；再读有用时给重试，重读期间转圈', async () => {
    const html = await render({ query: read(new ApiError(500, '服务内部错误'), true) })
    expect(html).toContain('服务内部错误')
    expect(toneOf(html)).toBe('error note-title')
    expect(retryButton(html)).toContain('animate-spin')
    const idle = await render({ query: read(new ApiError(500, '服务内部错误')) })
    expect(retryButton(idle)).toBeDefined()
    expect(retryButton(idle)).not.toContain('animate-spin')
  })

  it('不存在、无权访问这类确定的结果不给重试：再读也一样', async () => {
    for (const status of [403, 404]) {
      const html = await render({ query: read(new ApiError(status, '记忆不存在')) })
      expect(html).toContain('记忆不存在')
      expect(retryButton(html)).toBeUndefined()
    }
  })

  it('网络错误写兜底的说法：默认「读取失败」，传了 fallback 用它', async () => {
    expect(await render({ query: read(new TypeError('Failed to fetch')) })).toContain('读取失败')
    const html = await render({
      query: read(new TypeError('Failed to fetch')),
      fallback: '无法列出备份',
    })
    expect(html).toContain('无法列出备份')
    expect(retryButton(html)).toBeDefined()
  })

  it('读到过内容、刷新失败时用提醒的语气，写明是刷新失败', async () => {
    const html = await render({ query: read(new ApiError(502, '服务内部错误')), stale: true })
    expect(html).toContain('刷新失败：服务内部错误')
    expect(toneOf(html)).toBe('note-title warning')
  })

  it('点重试重读的是传进去的那一样', () => {
    expect(readFailureNote).toContain('@click="query.refetch()"')
    expect(readFailureNote).toContain(':loading="query.isFetching.value"')
    expect(readFailureNote).toContain('v-if="retryable(query.error.value)"')
    expect(readFailureNote).toContain('readFailure(query.error.value, fallback)')
  })
})

describe('查询的自动重试', () => {
  it('和界面上的「重试」同一条规则，最多再试两次', () => {
    const retry = queryClient.getDefaultOptions().queries!.retry as (
      count: number,
      error: unknown,
    ) => boolean
    expect(retry(0, new ApiError(429, '请求过于频繁'))).toBe(true)
    expect(retry(0, new ApiError(408, '请求超时'))).toBe(true)
    expect(retry(1, new TypeError('Failed to fetch'))).toBe(true)
    expect(retry(2, new TypeError('Failed to fetch'))).toBe(false)
    expect(retry(0, new ApiError(404, '记忆不存在'))).toBe(false)
    const zod = Object.assign(new Error('invalid'), { name: 'ZodError' })
    expect(retry(0, zod)).toBe(false)
  })
})

describe('几样一起读', () => {
  it('同一句说法只提示一次；没出错的跳过，不认识的错误不漏内部信息', () => {
    const groups = failedReads([
      read(new ApiError(500, '服务内部错误')),
      read(null),
      read(new ApiError(502, '服务内部错误')),
      read(new TypeError('Failed to fetch http://127.0.0.1')),
    ])
    expect(groups.map((g) => g.message)).toEqual(['服务内部错误', '读取失败'])
  })

  it('每条的重试只重读说这句话的那几样，转圈也只看它们', () => {
    const apps = read(new ApiError(500, '服务内部错误'))
    const personas = read(null, true)
    const members = read(new ApiError(503, '服务内部错误'))
    const [group] = failedReads([apps, personas, members])
    expect(group!.read.error.value).toBe(apps.error.value)
    // 成功的那一样在后台刷新，不算这一条在重读
    expect(group!.read.isFetching.value).toBe(false)
    members.isFetching.value = true
    expect(group!.read.isFetching.value).toBe(true)
    group!.read.refetch()
    expect(apps.refetch).toHaveBeenCalledOnce()
    expect(members.refetch).toHaveBeenCalledOnce()
    expect(personas.refetch).not.toHaveBeenCalled()
  })
})

describe('读取失败', () => {
  it.each([
    ['概览', overviewPage, 'overview'],
    ['记忆列表', memoryListView, 'list'],
    ['已过期的记忆', expiredMemories, 'expired'],
    ['已删除的记忆', deletedMemories, 'deleted'],
    ['记忆详情', memoryEditor, 'memory'],
    ['待确认内容', inboxReview, 'queue'],
    ['整理建议', dreamSuggestions, 'suggestions'],
    ['疑似明文凭据', inboxPlaintext, 'list'],
    ['账号绑定', inboxBindings, 'overview'],
    ['人格列表', personasPage, 'personas'],
    ['人格详情', personasPage, 'selected'],
    ['联系人', subjectsPage, 'section.query'],
    ['联系人详情', subjectDetailPage, 'subject'],
    ['凭据', credentialsPage, 'credentials'],
    ['已删除的凭据', credentialsPage, 'deleted'],
    ['凭据详情', credentialsPage, 'selected'],
    ['凭据引用的记忆', credentialDetail, 'references'],
    ['凭据的记录', credentialDetail, 'events'],
    ['召回', recallPage, 'stats'],
    ['变更记录', activityPage, 'activity'],
  ])('%s：主内容读取失败时交给 ReadFailureNote，重读的是这一样', (name, source, query) => {
    const queries = notesOf(source).map((note) => bound(note, 'query'))
    expect(queries, name).toContain(query)
  })

  it('不再各自复制「提示加重试按钮」：重试只在 ReadFailureNote 里', () => {
    const sources = import.meta.glob<string>('../**/*.vue', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const copied = Object.entries(sources)
      .filter(([path]) => !path.endsWith('/ReadFailureNote.vue'))
      .filter(([, source]) => /<NoteLine\b(?:(?!<\/NoteLine>)[^])*>\s*重试\s*</.test(source))
      .map(([path]) => path)
    expect(copied).toEqual([])
  })

  it('读取错误的文字都经过 readFailure，不各写一份兜底', () => {
    const sources = import.meta.glob<string>('../**/*.{vue,ts}', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const found = Object.entries(sources)
      .filter(([path]) => !path.includes('__tests__'))
      .filter(([, source]) => /\.error\.value instanceof ApiError/.test(source))
      .map(([path]) => path)
    expect(found).toEqual([])
  })

  it('应用列表和详情：同一句说法一条，各带自己的重试', () => {
    for (const [name, source] of [
      ['应用', appsPage],
      ['应用详情', appDetailPage],
    ] as const) {
      expect(source, name).toContain(
        'const failures = computed(() => failedReads([apps, personas, members]))',
      )
      const [note] = notesOf(source)
      expect(bound(note!, 'query'), name).toBe('failure.read')
      expect(note!.props?.find((p) => p.name === 'for')?.exp?.content, name).toBe(
        'failure in failures',
      )
    }
  })
})

describe('读到过的内容不被错误盖掉', () => {
  it('记忆目录：重读根节点失败时树照常显示、展开的节点不丢，错误放在上面', () => {
    expect(memoriesPage).toContain('<ReadFailureNote :query="rootsRead" />')
    expect(memoriesPage).toContain(
      'const rootsRead: ReadState = { error: rootsError, isFetching: loadingRoots, refetch: refresh }',
    )
    const tree = elementsOf(template(memoriesPage)).find((el) => el.tag === 'UTree')!
    const condition = tree.props?.find((p) => p.name === 'if')?.exp?.content
    expect(condition).toBe('loadingRoots || roots.length')
    expect(tree.props?.some((p) => p.name === 'else' || p.name === 'else-if')).toBe(false)
  })

  it.each([
    ['联系人详情', subjectDetailPage, 'subject', '<div v-else-if="!data" class="page-note">'],
    [
      '人格详情',
      personasPage,
      'selected',
      'v-if="selectedId !== null && selected.isError.value && !detail"',
    ],
    ['凭据详情', credentialsPage, 'selected', 'v-if="selected.isError.value && !detail"'],
  ])(
    '%s：没读到过才整块报错；读到过、刷新失败时照常显示，上面一条刷新失败',
    (name, source, query, whole) => {
      expect(source, name).toContain(whole)
      const stale = notesOf(source).filter(
        (note) => bound(note, 'query') === query && note.props?.some((p) => p.name === 'stale'),
      )
      expect(stale, name).toHaveLength(1)
    },
  )

  it('人格详情的刷新失败放在节点上面：PersonaDetail 给使用方留了位置', () => {
    expect(personaDetail).toContain('<slot name="notice" />')
    expect(personasPage).toContain('<template v-if="selected.isError.value" #notice>')
  })

  it('记忆详情：刷新失败时表单留着，提示带重试', () => {
    expect(memoryEditor).toContain(
      '<ReadFailureNote v-if="memory.isError.value" :query="memory" stale />',
    )
  })
})
