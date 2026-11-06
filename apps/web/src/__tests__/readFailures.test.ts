import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, h, ref, type Component } from 'vue'
import { parse } from 'vue/compiler-sfc'
import { renderToString } from 'vue/server-renderer'

import { ApiError, NetworkError } from '../api/client'
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
import subjectsPage from '../components/ContactList.vue?raw'
import conversationDetail from '../components/ConversationDetail.vue?raw'
import subjectDetailPage from '../pages/ContactDetailPage.vue?raw'
import conversationsPage from '../pages/ConversationsPage.vue?raw'
import { failedReads, queryClient } from '../query'

// 读取失败的写法：一律用 ReadFailureNote。文字经 readFailure；再读有用时给「重试」，重读的就是传进去的那一样，
// 重读期间转圈。读到过内容、还能再读的，内容照常显示，这一行写「刷新失败」

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

// 一样读取：读到的内容、错误、是否在读、重读
const read = (
  error: unknown,
  { data, isFetching = false }: { data?: unknown; isFetching?: boolean } = {},
) => ({
  data: ref(data),
  error: ref(error),
  isError: ref(error !== null),
  isFetching: ref(isFetching),
  refetch: vi.fn(),
})
const offline = () => new NetworkError(new TypeError('Failed to fetch'))

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
    const html = await render({
      query: read(new ApiError(500, '服务内部错误'), { isFetching: true }),
    })
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

  it('连不上时写兜底的说法：默认「读取失败」，传了 fallback 用它；程序自己的错误不给重试', async () => {
    expect(await render({ query: read(offline()) })).toContain('读取失败')
    const html = await render({ query: read(offline()), fallback: '无法列出备份' })
    expect(html).toContain('无法列出备份')
    expect(retryButton(html)).toBeDefined()
    expect(
      retryButton(await render({ query: read(new TypeError('x is undefined')) })),
    ).toBeUndefined()
  })

  it('读到过内容、还能再读时自己换成刷新失败的语气，不用使用方传', async () => {
    const html = await render({ query: read(new ApiError(502, '服务内部错误'), { data: [1] }) })
    expect(html).toContain('刷新失败：服务内部错误')
    expect(toneOf(html)).toBe('note-title warning')
    expect(retryButton(html)).toBeDefined()
  })

  it('读到过内容、但是确定的结果（别处删掉了）：照常是错误的语气，不写刷新失败', async () => {
    const html = await render({
      query: read(new ApiError(404, '凭据不存在'), { data: { id: 'c1' } }),
    })
    expect(html).not.toContain('刷新失败')
    expect(toneOf(html)).toBe('error note-title')
    expect(retryButton(html)).toBeUndefined()
  })

  it('点重试重读的是传进去的那一样，按钮大小跟着所在区块', () => {
    expect(readFailureNote).toContain('@click="query.refetch()"')
    expect(readFailureNote).toContain(':loading="query.isFetching.value"')
    expect(readFailureNote).toContain(':size="size"')
    expect(readFailureNote).toContain("size: 'sm'")
    expect(readFailureNote).toContain('readFailure(query.error.value, fallback)')
    // 凭据详情里两小节照原来用小一号的按钮
    expect(credentialDetail).toContain(':query="references" size="xs"')
    expect(credentialDetail).toMatch(/:query="events"\s+size="xs"/)
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
    expect(retry(1, offline())).toBe(true)
    expect(retry(2, offline())).toBe(false)
    expect(retry(0, new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(retry(0, new ApiError(404, '记忆不存在'))).toBe(false)
    // 程序自己的错误和契约对不上，再试也一样
    expect(retry(0, new TypeError('x is undefined'))).toBe(false)
    expect(retry(0, Object.assign(new Error('invalid'), { name: 'ZodError' }))).toBe(false)
  })
})

describe('几样一起读', () => {
  it('同一句说法只提示一次；没出错的跳过，不认识的错误不漏内部信息', () => {
    const groups = failedReads([
      read(new ApiError(500, '服务内部错误')),
      read(null),
      read(new ApiError(502, '服务内部错误')),
      read(offline()),
    ])
    expect(groups.map((g) => g.message)).toEqual(['服务内部错误', '读取失败'])
  })

  it('每条的重试只重读这一组，转圈也只看它们', () => {
    const apps = read(new ApiError(500, '服务内部错误'))
    const personas = read(null, { isFetching: true })
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

  it('同一句话，能再读的和不能再读的分开：不能再读的那条没有重试，能再读的只重读它们', () => {
    const transient = read(new ApiError(503, '暂时无法读取'))
    const final = read(new ApiError(403, '暂时无法读取'))
    const groups = failedReads([transient, final])
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map((g) => g.key)).size).toBe(2)
    const again = groups.find((g) => g.read.error.value === transient.error.value)!
    again.read.refetch()
    expect(transient.refetch).toHaveBeenCalledOnce()
    expect(final.refetch).not.toHaveBeenCalled()
  })

  it('一组里每样都读到过内容才算刷新失败', () => {
    const a = read(new ApiError(500, '服务内部错误'), { data: [] })
    const b = read(new ApiError(500, '服务内部错误'))
    expect(failedReads([a])[0]!.read.data.value).not.toBeUndefined()
    expect(failedReads([a, b])[0]!.read.data.value).toBeUndefined()
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
    ['会话', conversationsPage, 'list'],
    ['会话详情', conversationDetail, 'detail'],
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
    // 有没有读到过看根节点：有就写刷新失败
    expect(memoriesPage).toContain(
      'data: computed(() => (roots.value.length ? roots.value : undefined))',
    )
    const tree = elementsOf(template(memoriesPage)).find((el) => el.tag === 'UTree')!
    const condition = tree.props?.find((p) => p.name === 'if')?.exp?.content
    expect(condition).toBe('loadingRoots || roots.length')
    expect(tree.props?.some((p) => p.name === 'else' || p.name === 'else-if')).toBe(false)
  })

  it('记忆目录：换空间时上一个空间的树和错误都清掉，不拿旧的节点去请求新空间', () => {
    const watcher = /watch\(spaceId, \(\) => \{[^]*?\n\}\)/.exec(memoriesPage)![0]
    expect(watcher).toContain('roots.value = []')
    expect(watcher).toContain('rootsError.value = null')
    expect(watcher).toContain('expanded.value = []')
    expect(watcher.indexOf('roots.value = []')).toBeLessThan(watcher.indexOf('serially(loadRoots)'))
  })

  it.each([
    [
      '联系人详情',
      subjectDetailPage,
      'subject',
      'v-else-if="!data || (subject.isError.value && !retryable(subject.error.value))"',
    ],
    [
      '会话详情',
      conversationDetail,
      'detail',
      'v-else-if="!data || (detail.isError.value && !retryable(detail.error.value))"',
    ],
    ['人格详情', personasPage, 'selected', '(!detail || !retryable(selected.error.value))'],
    [
      '凭据详情',
      credentialsPage,
      'selected',
      'v-if="selected.isError.value && (!detail || !retryable(selected.error.value))"',
    ],
  ])(
    '%s：没读到过、或是确定的结果（删掉、合并后的 404）时整块报错；还能再读的刷新失败才留着内容',
    (name, source, query, whole) => {
      expect(source.replace(/\s+/g, ' '), name).toContain(whole)
      // 留着内容时上面也有一条，说法由 ReadFailureNote 按有没有读到过自己定，不用传
      const notes = notesOf(source).filter((note) => bound(note, 'query') === query)
      expect(notes.length, name).toBe(2)
      for (const note of notes) {
        expect(
          note.props?.some((p) => p.name === 'stale' || p.arg?.content === 'stale'),
          name,
        ).toBe(false)
      }
    },
  )

  it('人格详情的刷新失败放在节点上面：PersonaDetail 给使用方留了位置', () => {
    expect(personaDetail).toContain('<slot name="notice" />')
    expect(personasPage).toContain('<template v-if="selected.isError.value" #notice>')
  })

  it('记忆详情：刷新失败时表单留着，提示带重试', () => {
    expect(memoryEditor).toContain(
      '<ReadFailureNote v-if="memory.isError.value" :query="memory" />',
    )
  })

  it('哪里都不再自己传 stale：读到过没有由 ReadFailureNote 自己看', () => {
    const sources = import.meta.glob<string>('../**/*.vue', {
      query: '?raw',
      import: 'default',
      eager: true,
    })
    const passing = Object.entries(sources)
      .filter(([, source]) => /<ReadFailureNote\b[^>]*\bstale\b/.test(source))
      .map(([path]) => path)
    expect(passing).toEqual([])
  })
})
