import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import { ApiError, readFailure, retryable } from '../api/client'
import deletedMemories from '../components/DeletedMemories.vue?raw'
import dreamSuggestions from '../components/DreamSuggestions.vue?raw'
import expiredMemories from '../components/ExpiredMemories.vue?raw'
import extractionBudget from '../components/ExtractionBudget.vue?raw'
import inboxBindings from '../components/InboxBindings.vue?raw'
import inboxPlaintext from '../components/InboxPlaintext.vue?raw'
import inboxReview from '../components/InboxReview.vue?raw'
import memoryEditor from '../components/MemoryEditor.vue?raw'
import memoryListView from '../components/MemoryListView.vue?raw'
import myDreamSettings from '../components/MyDreamSettings.vue?raw'
import activityPage from '../pages/ActivityPage.vue?raw'
import appDetailPage from '../pages/AppDetailPage.vue?raw'
import appsPage from '../pages/AppsPage.vue?raw'
import credentialsPage from '../pages/CredentialsPage.vue?raw'
import memoriesPage from '../pages/MemoriesPage.vue?raw'
import overviewPage from '../pages/OverviewPage.vue?raw'
import personasPage from '../pages/PersonasPage.vue?raw'
import recallPage from '../pages/RecallPage.vue?raw'
import settingsPage from '../pages/SettingsPage.vue?raw'
import subjectDetailPage from '../pages/SubjectDetailPage.vue?raw'
import subjectsPage from '../pages/SubjectsPage.vue?raw'

// 读取失败的写法：文字一律用 readFailure；一页的主内容没读出来时旁边有「重试」，重新读的就是没读出来的那一样

interface TemplateNode {
  type: number
  tag?: string
  content?: unknown
  children?: TemplateNode[]
  props?: {
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const INTERPOLATION = 5
const template = (source: string) =>
  parse(source).descriptor.template!.ast as unknown as TemplateNode
const elementsOf = (node: TemplateNode): TemplateNode[] => [
  ...(node.type === ELEMENT ? [node] : []),
  ...(node.children ?? []).flatMap(elementsOf),
]
const directive = (el: TemplateNode, name: string) => el.props?.find((p) => p.name === name)
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content
const textOf = (el: TemplateNode): string =>
  (el.children ?? [])
    .map((c) => (typeof c.content === 'string' ? c.content : ''))
    .join('')
    .trim()
// 元素自己的插值，比如 {{ readFailure(list.error.value) }}
const interpolations = (el: TemplateNode) =>
  (el.children ?? [])
    .filter((c) => c.type === INTERPOLATION)
    .map((c) => (c.content as { content: string }).content.trim())

// 写着这句错误的 NoteLine 的「重试」按钮
function retryButtons(source: string, message: string) {
  return elementsOf(template(source))
    .filter((el) => el.tag === 'NoteLine' && interpolations(el).includes(message))
    .flatMap((note) =>
      (note.children ?? []).filter(
        (c) => c.tag === 'template' && directive(c, 'slot')?.arg?.content === 'actions',
      ),
    )
    .flatMap(elementsOf)
    .filter((el) => el.tag === 'UButton' && textOf(el) === '重试')
}

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
    ['召回', recallPage, 'stats'],
    ['变更记录', activityPage, 'activity'],
    ['抽取预算', extractionBudget, 'usage'],
    ['整理个人画像层与私人层的开关', myDreamSettings, 'settings'],
    ['主密钥', settingsPage, 'masterKey'],
  ])('%s：主内容读取失败时有重试，重新读的是这一样', (name, source, query) => {
    const buttons = retryButtons(source, `readFailure(${query}.error.value)`)
    expect(buttons.length, name).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(handler(button, 'click'), name).toBe(`${query}.refetch()`)
      expect(bound(button, 'loading'), name).toBe(`${query}.isFetching.value`)
    }
  })

  it('记忆目录：读不出整棵树时写服务端的说明，重试重新载入目录', () => {
    const [button] = retryButtons(memoriesPage, 'readFailure(rootsError)')
    expect(button).toBeDefined()
    expect(handler(button!, 'click')).toBe('refresh')
    expect(bound(button!, 'loading')).toBe('loadingRoots')
    expect(memoriesPage).not.toMatch(/>\s*读取失败\s*</)
  })

  it.each([
    ['应用', appsPage],
    ['应用详情', appDetailPage],
  ])('%s：读的几样里有失败的，重试只重读失败的那几样', (name, source) => {
    const [button] = retryButtons(source, 'message')
    expect(button, name).toBeDefined()
    expect(handler(button!, 'click'), name).toBe('retryReads')
    expect(bound(button!, 'loading'), name).toBe('retrying')
    expect(source).toContain('if (query.isError.value) void query.refetch()')
  })

  it('详情读到的是「不存在」时不给重试：再读也一样', () => {
    for (const [source, query] of [
      [memoryEditor, 'memory'],
      [personasPage, 'selected'],
      [subjectDetailPage, 'subject'],
      [credentialsPage, 'selected'],
    ] as const) {
      expect(source).toContain(`<template v-if="retryable(${query}.error.value)" #actions>`)
    }
    expect(retryable(new ApiError(404, '记忆不存在'))).toBe(false)
    expect(retryable(new ApiError(403, '无权访问'))).toBe(false)
    expect(retryable(new ApiError(500, '服务内部错误'))).toBe(true)
    expect(retryable(new TypeError('Failed to fetch'))).toBe(true)
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
    expect(readFailure(new ApiError(500, '服务内部错误'))).toBe('服务内部错误')
    expect(readFailure(new TypeError('Failed to fetch'))).toBe('读取失败')
  })
})
