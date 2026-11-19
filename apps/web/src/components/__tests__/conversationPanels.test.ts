import type { ConversationDetail as Detail } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import ConversationDetail from '../ConversationDetail.vue'
import personaDetailSource from '../PersonaDetail.vue?raw'
import promoteFactModalSource from '../PromoteFactModal.vue?raw'

// 提示层依赖组件库的 provider，这里只看内容本身
vi.mock('../Hint.vue', () => ({
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h('i', slots.default?.()),
  }),
}))

const CIRCLE = '00000000-0000-4000-8000-0000000000s1'
const at = '2026-11-06T08:00:00.000Z'

const NAMES = ['home', 'memories', 'conversations', 'contact', 'client', 'clients', 'vocabulary']
async function render(
  component: Component,
  props: Record<string, unknown>,
  seed: [unknown[], unknown][],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  for (const [key, value] of seed) queryClient.setQueryData(key, value)
  const empty = { render: () => null }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: NAMES.map((name, i) => ({
      path: i === 0 ? '/' : `/${name}/:circleId?/:clientId?/:subjectId?`,
      name,
      component: empty,
    })),
  })
  await router.push('/')
  const app = createSSRApp(component, props)
  app.use(VueQueryPlugin, { queryClient })
  app.use(router)
  return renderToString(app)
}

const detail = (over: Partial<Detail> = {}): Detail => ({
  id: '00000000-0000-4000-8000-000000000001',
  circleId: CIRCLE,
  kind: 'group',
  client: { id: '00000000-0000-4000-8000-0000000000a1', name: 'QQ 机器人' },
  deviceKey: '',
  projectSlug: '',
  subject: { id: '00000000-0000-4000-8000-0000000000b1', kind: 'group', displayName: '读书会' },
  owner: null,
  displayName: '读书会',
  createdAt: at,
  lastActiveAt: at,
  latestSummary: { excerpt: '讨论了第三章', createdAt: at },
  summaryCount: 1,
  summaries: [
    {
      id: '00000000-0000-4000-8000-0000000000c1',
      shortId: 'ep-0001',
      content: '讨论了第三章',
      provenance: 'untrusted',
      createdAt: at,
      expiresAt: null,
    },
  ],
  facts: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
      shortId: 'fa-0001',
      content: '在学日语',
      provenance: 'untrusted',
      subject: { id: '00000000-0000-4000-8000-0000000000b2', kind: 'person', displayName: '张三' },
      version: 1,
      createdAt: at,
      updatedAt: at,
    },
  ],
  runs: [],
  ...over,
})

describe('会话详情', () => {
  it('群聊：摘要的时间线与短 ID、在这里记下的事实连着各自的联系人', async () => {
    const data = detail()
    const html = await render(ConversationDetail, { circleId: CIRCLE, id: data.id }, [
      [['conversation', CIRCLE, data.id], data],
    ])
    expect(html).toContain('读书会')
    expect(html).toContain('QQ 机器人')
    expect(html).toContain('群聊')
    expect(html).toContain('讨论了第三章')
    expect(html).toContain('ep-0001')
    expect(html).toContain('在学日语')
    expect(html).toContain('fa-0001')
    expect(html).toContain('张三')
    expect(html).toContain('未确认来源')
  })

  it('不带会话上下文：按接入实例、项目与设备区分，写「本人」，不列事实', async () => {
    const data = detail({
      kind: 'none',
      subject: null,
      owner: { id: '00000000-0000-4000-8000-0000000000e1', displayName: 'LM' },
      displayName: 'LM',
      client: { id: '00000000-0000-4000-8000-0000000000a2', name: 'Claude Code' },
      deviceKey: 'macbook',
      projectSlug: 'kioku',
      facts: [],
    })
    const html = await render(ConversationDetail, { circleId: CIRCLE, id: data.id }, [
      [['conversation', CIRCLE, data.id], data],
    ])
    expect(html).toContain('Claude Code · kioku · macbook')
    expect(html).toContain('项目 kioku')
    expect(html).toContain('设备 macbook')
    expect(html).toContain('本人')
    expect(html).not.toContain('在这里记下的事实')
    expect(html).toContain('不带会话上下文的会话只写摘要')
  })
})

describe('提炼事实弹窗', () => {
  it('不使用 form 防止隐式提交，调用 promoteFact 与切面选择器', () => {
    expect(promoteFactModalSource).not.toContain('<form')
    expect(promoteFactModalSource).toContain('api.promoteFact')
    expect(promoteFactModalSource).toContain('<FacetWhenPicker')
    expect(promoteFactModalSource).toContain('sensitivityAllowed')
  })
})

describe('独立人格详情', () => {
  it('管理设定段而不使用 persona://，展示客户端引用并保留通知插槽', () => {
    expect(personaDetailSource).not.toContain('persona://')
    expect(personaDetailSource).toContain('api.upsertPersonaTrait')
    expect(personaDetailSource).toContain('api.deletePersonaTrait')
    expect(personaDetailSource).toContain('persona.clients')
    expect(personaDetailSource).toContain('<slot name="notice"')
  })
})
