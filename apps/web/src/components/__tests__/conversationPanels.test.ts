import type { ConversationDetail as Detail, PersonaInfo } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import AppPanel from '../AppPanel.vue'
import ConversationDetail from '../ConversationDetail.vue'
import CoordinateFields from '../CoordinateFields.vue'
import MemoryRootPanel from '../MemoryRootPanel.vue'
import { tallyCounts } from '../strata/strata'

// 提示层依赖组件库的 provider，这里只看内容本身
vi.mock('../Hint.vue', () => ({
  default: defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h('i', slots.default?.()),
  }),
}))

const SPACE = 's1'
const at = '2026-11-06T08:00:00.000Z'

// 链接要解析路由名（组件库的按钮带 to 时也是），挂一个只有这几个名字的路由；查询的结果先放进缓存，渲染时直接用
const NAMES = ['home', 'memories', 'conversations', 'contact', 'app', 'apps', 'credentials']
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
      path: i === 0 ? '/' : `/${name}/:spaceId?/:appId?/:subjectId?`,
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
  kind: 'group',
  app: { id: '00000000-0000-4000-8000-0000000000a1', name: 'QQ 机器人' },
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
      content: '讨论了第三章',
      provenance: 'untrusted',
      createdAt: at,
      expiresAt: null,
    },
  ],
  facts: [
    {
      id: '00000000-0000-4000-8000-0000000000d1',
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
  it('群聊：摘要的时间线、在这里记下的事实连着各自的联系人', async () => {
    const data = detail()
    const html = await render(ConversationDetail, { spaceId: SPACE, id: data.id }, [
      [['conversation', SPACE, data.id], data],
    ])
    expect(html).toContain('读书会')
    expect(html).toContain('QQ 机器人')
    expect(html).toContain('群聊')
    expect(html).toContain('讨论了第三章')
    expect(html).toContain('在学日语')
    expect(html).toContain('张三')
    expect(html).toContain('未确认来源')
  })

  it('不带会话上下文：名字写应用，写「本人」，不列事实', async () => {
    const data = detail({
      kind: 'none',
      subject: null,
      owner: { id: '00000000-0000-4000-8000-0000000000e1', displayName: 'LM' },
      displayName: 'LM',
      app: { id: '00000000-0000-4000-8000-0000000000a2', name: 'Claude Code' },
      facts: [],
    })
    const html = await render(ConversationDetail, { spaceId: SPACE, id: data.id }, [
      [['conversation', SPACE, data.id], data],
    ])
    expect(html).toMatch(/<h2 tabindex="-1"[^>]*>Claude Code<\/h2>/)
    // 名字已经是应用了，下面一行不再重复
    expect(html.match(/Claude Code/g)).toHaveLength(1)
    expect(html).toContain('本人')
    expect(html).not.toContain('在这里记下的事实')
    expect(html).toContain('不带会话上下文的会话只写摘要')
  })
})

describe('记忆目录的根', () => {
  const personas: PersonaInfo[] = [
    { id: 'p1', slug: 'default', name: '默认', extendsId: null, description: null },
    { id: 'p2', slug: 'doubao', name: '豆包', extendsId: 'p1', description: null },
  ]
  const counts = tallyCounts([
    { layer: 'persona', sensitivity: 'public', count: 3 },
    { layer: 'user', sensitivity: 'private', count: 5 },
  ])

  it('人格的根列出各个人格与继承，坐标开头写在底部，适用范围在提示层', async () => {
    const html = await render(
      MemoryRootPanel,
      { spaceId: SPACE, layer: 'persona', counts, canWrite: true, canEditPersonas: true },
      [
        [['personas', SPACE], personas],
        [['apps', SPACE], []],
      ],
    )
    expect(html).toContain('默认')
    expect(html).toContain('继承默认')
    expect(html).toContain('persona://')
    expect(html).toContain('使用该人格的应用，含子人格')
    expect(html).toContain('新建人格')
  })

  it('本人的根不列公开那一档', async () => {
    const html = await render(
      MemoryRootPanel,
      { spaceId: SPACE, layer: 'user', counts, canWrite: false, canEditPersonas: false },
      [],
    )
    expect(html).toContain('私密')
    expect(html).not.toContain('公开')
    expect(html).toContain('user://')
    expect(html).not.toContain('新建记忆')
  })
})

describe('新建与移动的坐标', () => {
  it('人格要选是哪个，坐标随归属、位置与标识拼出来', async () => {
    const html = await render(
      CoordinateFields,
      {
        modelValue: { layer: 'persona', entity: 'doubao', position: 'style', identifier: 'tone' },
        personas: [{ id: 'p2', slug: 'doubao', name: '豆包', extendsId: null, description: null }],
        apps: [],
      },
      [],
    )
    expect(html).toContain('persona://doubao/style/tone')
    expect(html).toContain('aria-label="人格"')
  })
})

describe('目录里选中一个应用', () => {
  const app = {
    id: '00000000-0000-4000-8000-0000000000a1',
    slug: 'claudecode',
    name: 'Claude Code',
    runtimeFamily: 'claudecode',
    ownerAccountId: '00000000-0000-4000-8000-0000000000f1',
    defaultPersonaId: 'p1',
    config: {},
  }
  const memory = {
    id: '00000000-0000-4000-8000-0000000000c9',
    uri: 'app://claudecode/commit_style',
    title: '提交规范',
    layer: 'app' as const,
    sensitivity: 'internal' as const,
    provenance: 'owner' as const,
    priority: 1,
    disclosure: '要写提交信息时',
    personaId: null,
    appId: app.id,
    version: 1,
    updatedAt: at,
    validTo: null,
  }
  const persona = { id: 'p1', slug: 'default', name: '默认', extendsId: null, description: null }

  it('它的记忆写标题，会话与访问密钥的入口都在，底部是坐标开头', async () => {
    const html = await render(AppPanel, { spaceId: SPACE, appId: app.id, canWrite: true }, [
      [['apps', SPACE], [app]],
      [['personas', SPACE], [persona]],
      [
        ['memory-list', SPACE, { under: 'claudecode', panel: true }],
        { items: [memory], nextCursor: null },
      ],
      [['conversations', SPACE, app.id, 'recent'], { items: [], nextCursor: null }],
      [['overview', SPACE], { apps: [{ id: app.id, keys: { active: 2, lastUsedAt: null } }] }],
    ])
    expect(html).toContain('提交规范')
    expect(html).toContain('默认')
    expect(html).toContain('暂无会话')
    expect(html).toContain('有效访问密钥')
    expect(html).toContain('app://claudecode/')
  })
})
