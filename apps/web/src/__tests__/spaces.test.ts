import type { CircleSummary, Me } from '@kioku/contracts'
import { QueryClient, QueryObserver, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import endpoints from '../api/endpoints.ts?raw'
import createSpaceModal from '../components/CreateSpaceModal.vue?raw'
import deleteSpaceModal from '../components/DeleteSpaceModal.vue?raw'
import importSpaceModal from '../components/ImportSpaceModal.vue?raw'
import instanceCircles from '../components/InstanceSpaces.vue?raw'
import circleGeneral from '../components/SpaceGeneralSettings.vue?raw'
import circleImport from '../components/SpaceImport.vue?raw'
import circleMembers from '../components/SpaceMembers.vue?raw'
import circleTransferSettings from '../components/SpaceTransferSettings.vue?raw'
import useCreateSpace from '../composables/useCreateSpace.ts?raw'
import { useAfterCircleGone } from '../composables/useLeaveSpace'
import leaveSource from '../composables/useLeaveSpace.ts?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import HomePage from '../pages/HomePage.vue'
import homePage from '../pages/HomePage.vue?raw'
import { ME_KEY, queryClient } from '../query'
import {
  CIRCLE_LIMIT_KEY,
  circleLimitNote,
  circleNameIssue,
  confirmsName,
  DELETE_CONSEQUENCES,
  initialOf,
  isLastOwner,
  LAST_OWNER_NOTE,
  LEAVE_CONSEQUENCES,
  memberAction,
  nextCircle,
  refreshCircles,
  REMOVE_CONSEQUENCES,
  roleEditable,
  transferTargets,
} from '../spaces'

const owner = { accountId: 'a', role: 'owner' as const }
const editor = { accountId: 'b', role: 'editor' as const }
const viewer = { accountId: 'c', role: 'viewer' as const }

describe('删除共享记忆圈要输对名字', () => {
  it('逐字一致才能删：多空格、大小写不同、空名都不行', () => {
    expect(confirmsName('家', '家')).toBe(true)
    expect(confirmsName('家 ', '家')).toBe(false)
    expect(confirmsName('home', 'Home')).toBe(false)
    expect(confirmsName('', '')).toBe(false)
  })

  it('弹窗里按钮在名字对上之前不能点，后果写全，链到导入与导出', () => {
    expect(deleteSpaceModal).toContain(':disabled="!matches"')
    expect(deleteSpaceModal).toContain('confirmsName(typed.value, props.circleName)')
    expect(deleteSpaceModal).toContain("circleSettingsRoute(circleId, 'transfer')")
    expect(deleteSpaceModal).not.toContain('<form')
    expect(DELETE_CONSEQUENCES.join('')).toContain('记忆圈内的词条、会话、凭据与访问密钥全部删除')
    expect(DELETE_CONSEQUENCES.join('')).toContain('关联的接入实例立即失去访问')
  })

  it('个人圈不可转让、离开或删除；实例列表仅共享圈显示删除', () => {
    expect(circleGeneral).toContain(
      'v-if="detail.data.value && detail.data.value.kind === \'shared\'"',
    )
    expect(circleGeneral).toContain('v-if="isOwner || isAdmin"')
    expect(instanceCircles).toContain('v-if="c.kind === \'shared\'"')
    expect(instanceCircles).toContain('<DeleteSpaceModal')
  })
})

describe('至少一个所有者', () => {
  it('唯一的所有者离开、被移除时按钮给出但不能点，写出原因', () => {
    expect(isLastOwner([owner, editor], 'a')).toBe(true)
    expect(isLastOwner([owner, { ...editor, role: 'owner' }], 'a')).toBe(false)
    expect(isLastOwner([owner, editor], 'b')).toBe(false)
    expect(memberAction(owner, owner, [owner, editor])).toEqual({
      kind: 'leave',
      blocked: LAST_OWNER_NOTE,
    })
    expect(memberAction(owner, editor, [owner, editor])).toEqual({
      kind: 'remove',
      blocked: null,
    })
    const two = [owner, { ...editor, role: 'owner' as const }]
    expect(memberAction(owner, owner, two)).toEqual({ kind: 'leave', blocked: null })
  })

  it('概况里的离开记忆圈在唯一的所有者时不能点，旁边写原因', () => {
    expect(circleGeneral).toContain(':disabled="lastOwner"')
    expect(circleGeneral).toContain('lastOwner ? LAST_OWNER_NOTE : LEAVE_NOTE')
  })
})

describe('只读角色', () => {
  it('只有所有者能改别人的角色；自己的、非所有者看到的都只读', () => {
    expect(roleEditable(owner, editor)).toBe(true)
    expect(roleEditable(owner, owner)).toBe(false)
    expect(roleEditable(editor, viewer)).toBe(false)
    expect(roleEditable(viewer, editor)).toBe(false)
  })

  it('非所有者看不到移除别人，只有自己那一行的离开', () => {
    expect(memberAction(editor, viewer, [owner, editor, viewer])).toBeNull()
    expect(memberAction(editor, editor, [owner, editor, viewer])).toEqual({
      kind: 'leave',
      blocked: null,
    })
  })

  it('添加成员只给所有者；成员表显示接入实例列', () => {
    expect(circleMembers).toContain('<div v-if="isOwner" class="add-member">')
    expect(circleMembers).toContain('v-if="roleEditable(viewer, row)"')
    expect(circleMembers).toContain('row.clientCount')
    expect(circleMembers).not.toContain('row.appCount')
  })

  it('转让给别的成员；离开与移除的后果写明吊销与 30 天', () => {
    expect(transferTargets([owner, editor, viewer], 'a').map((m) => m.accountId)).toEqual([
      'b',
      'c',
    ])
    for (const lines of [LEAVE_CONSEQUENCES, REMOVE_CONSEQUENCES]) {
      expect(lines.join('')).toContain('访问密钥立即吊销')
      expect(lines.join('')).toContain('保留 30 天')
    }
  })

  it('头像取显示名的第一个字，不切开代理对', () => {
    expect(initialOf('审阅者')).toBe('审')
    expect(initialOf('😀 x')).toBe('😀')
    expect(initialOf('  ')).toBe('?')
  })
})

describe('离开后跳转', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    queryClient.clear()
  })

  const PERSONAL_ID = '00000000-0000-4000-8000-000000000001'
  const GONE = '00000000-0000-4000-8000-0000000000c0'

  const circleRow = (
    id: string,
    name: string,
    kind: CircleSummary['kind'],
    role: CircleSummary['role'],
  ): CircleSummary => ({ id, slug: name, name, kind, role })

  const me = (circles: CircleSummary[], personalCircleId = PERSONAL_ID): Me => ({
    id: '00000000-0000-4000-8000-00000000000a',
    username: 'alice',
    displayName: 'alice',
    isAdmin: false,
    personalCircleId,
    circles,
    ownedSharedCircles: circles.filter((c) => c.kind === 'shared' && c.role === 'owner').length,
    maxOwnedCircles: 5,
  })

  async function leaveFrom(
    circles: CircleSummary[],
    from = `/circles/${GONE}`,
    observe?: readonly unknown[],
  ) {
    // 取会话时页面已经换到了哪里：要先离开那个记忆圈的页面，再重取
    const routeAtFetch: unknown[] = []
    const fetched = vi.fn(async () => {
      routeAtFetch.push(router.currentRoute.value.name)
      return new Response(JSON.stringify(me(circles)), { status: 200 })
    })
    vi.stubGlobal('fetch', fetched)
    // 缓存里的会话还有那个记忆圈：跳去哪里按它挑
    queryClient.setQueryData(ME_KEY, me([circleRow(GONE, '要走的', 'shared', 'owner'), ...circles]))
    // 那个记忆圈的查询还在缓存里：离开之后丢掉，不失效重取
    queryClient.setQueryData(['members', GONE], [])
    // 还有组件挂着的查询（observe）不丢
    const watching = observe
      ? new QueryObserver(queryClient, {
          queryKey: observe,
          queryFn: async () => [],
          enabled: false,
        })
      : null
    const stop = watching?.subscribe(() => {})
    // eslint-disable-next-line prefer-const
    let router: ReturnType<typeof createRouter>
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: { render: () => null } },
        { path: '/circles/:circleId', name: 'overview', component: { render: () => null } },
        { path: '/settings/instance', name: 'instance', component: { render: () => null } },
      ],
    })
    await router.push(from)
    let afterGone!: (id: string) => Promise<void>
    const app = createSSRApp(
      defineComponent({
        setup() {
          afterGone = useAfterCircleGone()
          return () => h('div')
        },
      }),
    )
    app.use(router)
    await renderToString(app)
    await afterGone(GONE)
    const result = {
      route: router.currentRoute.value,
      cached: queryClient.getQueryData<Me>(ME_KEY),
      meRequests: fetched.mock.calls.length,
      routeAtFetch,
      membersLeft: queryClient.getQueryState(['members', GONE]),
      observedLeft: observe ? queryClient.getQueryState(observe) : undefined,
    }
    stop?.()
    return result
  }

  it('还有个人圈或其他记忆圈时优先回到个人圈概览，会话里的列表是新读的', async () => {
    const { route, cached } = await leaveFrom([
      circleRow('00000000-0000-4000-8000-0000000000b0', '别处', 'shared', 'editor'),
      circleRow(PERSONAL_ID, '个人记忆圈', 'personal', 'owner'),
    ])
    expect(route.name).toBe('overview')
    expect(route.params.circleId).toBe(PERSONAL_ID)
    expect(cached?.circles.map((c) => c.id)).toEqual([
      '00000000-0000-4000-8000-0000000000b0',
      PERSONAL_ID,
    ])
  })

  it('会话只重取一次，那个记忆圈的查询丢掉', async () => {
    const { meRequests, membersLeft } = await leaveFrom([])
    expect(meRequests).toBe(1)
    expect(membersLeft).toBeUndefined()
  })

  it('先离开那个记忆圈的页面，再重取会话、丢掉它的查询', async () => {
    const { routeAtFetch } = await leaveFrom([])
    expect(routeAtFetch).toEqual(['home'])
    const source = leaveSource.slice(leaveSource.indexOf('export function useAfterCircleGone'))
    expect(source.indexOf('router.replace')).toBeLessThan(source.indexOf('fetchQuery'))
    expect(source.indexOf('fetchQuery')).toBeLessThan(source.indexOf('dropCircleQueries'))
  })

  it('在实例 › 记忆圈删掉别的记忆圈：留在原页，记住的记忆圈正是它时忘掉；还有组件挂着的查询不丢', async () => {
    const observed = ['circle', GONE]
    const { route, membersLeft, observedLeft } = await leaveFrom([], '/settings/instance', observed)
    expect(route.name).toBe('instance')
    expect(membersLeft).toBeUndefined()
    expect(observedLeft).toBeDefined()
    expect(leaveSource).toContain('forgetCircle(circleId)')
    expect(leaveSource).toContain('if (route.params.circleId === circleId)')
    expect(instanceCircles).toContain('await afterGone(gone.id)')
  })

  it('没有记忆圈了回首页', async () => {
    const { route } = await leaveFrom([])
    expect(route.name).toBe('home')
  })

  it('nextCircle 跳过已离开的圈并优先选个人圈', () => {
    const circles = [
      { id: 'gone', kind: 'shared' },
      { id: 'b', kind: 'shared' },
      { id: 'personal', kind: 'personal' },
    ]
    expect(nextCircle(circles, 'gone', 'personal')).toBe('personal')
    expect(nextCircle(circles, 'gone')).toBe('b')
    expect(nextCircle(circles.slice(0, 1), 'gone', 'personal')).toBeNull()
  })
})

describe('新建共享圈与导入记忆圈的入口', () => {
  it('首页没有记忆圈时给新建共享圈与导入记忆圈', () => {
    expect(homePage).toContain('<template v-if="newCircle" #actions>')
    expect(homePage).not.toContain('blocked')
    expect(homePage).toContain('@click="newCircle.importing.value = true"')
    expect(homePage).toContain('请记忆圈所有者将当前账号加为成员')
    expect(homePage).toContain('<EmptyState')
  })

  it('新建共享圈只填名称：不选所有者，也不读账号列表', () => {
    expect(createSpaceModal).toContain('api.createCircle({ name: trimmed.value })')
    expect(createSpaceModal).not.toContain('ownerAccountId')
    expect(createSpaceModal).not.toContain('api.accounts')
    expect(instanceCircles).not.toContain('CreateSpaceModal')
    expect(instanceCircles).not.toContain('SpaceImport')
  })

  it('共享圈名额的说明：用完才有，写出上限是几个；没读到时不拦', () => {
    expect(circleLimitNote(undefined)).toBeNull()
    expect(circleLimitNote({ maxOwnedCircles: 5, ownedCircles: 4, canCreate: true })).toBeNull()
    expect(circleLimitNote({ maxOwnedCircles: 5, ownedCircles: 5, canCreate: false })).toBe(
      '已达共享记忆圈数量上限（5 个）',
    )
  })

  it('导入个人圈包不占共享圈配额，检查文件不受共享圈上限阻拦', () => {
    expect(circleImport).toContain(
      "preview.value?.circleKind === 'shared' && Boolean(blocked.value)",
    )
    expect(circleImport).toContain("intoPersonalCircle: currentPreview.circleKind === 'personal'")
    expect(circleImport).toContain(':disabled="!canInspect"')
    expect(circleImport).toContain(':disabled="!canImport"')
  })

  it('记忆圈与成员变了，名额跟着重取：新建、导入、删除、离开、转让都经 refreshCircles', async () => {
    const client = new QueryClient()
    client.setQueryData(CIRCLE_LIMIT_KEY, { maxOwnedCircles: 5, ownedCircles: 1, canCreate: true })
    await refreshCircles(client)
    expect(client.getQueryState(CIRCLE_LIMIT_KEY)?.isInvalidated).toBe(true)
    expect(circleImport).toContain(
      'await refreshCircles(queryClient, undefined, { accounts: true })',
    )
    expect(useCreateSpace).toContain(
      'await refreshCircles(queryClient, undefined, { accounts: true })',
    )
    expect(leaveSource).toContain(
      'refreshCircles(queryClient, undefined, { me: false, accounts: true })',
    )
  })

  it('实例 › 记忆圈：上限是一项数值设置，放在表单里，范围取契约的常量', () => {
    expect(instanceCircles).toContain('<form v-else-if="limit.data.value" @submit.prevent="save">')
    expect(instanceCircles).toContain('schema: MaxOwnedCircles')
    expect(instanceCircles).toContain(
      '请填写 {{ CIRCLE_LIMIT_MIN }} 到 {{ CIRCLE_LIMIT_MAX }} 之间的整数。',
    )
    expect(instanceCircles).toContain('<SaveBar')
    expect(instanceCircles).toContain('queryClient.setQueryData(CIRCLE_LIMIT_KEY, view)')
    expect(instanceCircles).not.toContain('USwitch')
    expect(instanceCircles).not.toContain('icons.add')
  })

  it('导入记忆圈的弹窗：检查、导入期间不能关；导入表单在设置里与弹窗里是同一个组件', () => {
    expect(importSpaceModal).toContain(':dismissible="!busy"')
    expect(importSpaceModal).toContain('<SpaceImport v-model:busy="busy" bare')
    expect(circleTransferSettings).toContain('<SpaceImport />')
    expect(circleImport).toContain('enabled: computed(() => me.data.value?.isAdmin ?? false)')
  })
})

describe('审查修复', () => {
  it('记忆圈名按码点数长度，和服务端同一个 schema；问题文字走 fieldProblems', () => {
    expect(circleNameIssue('😀'.repeat(40))).toBeNull()
    expect(circleNameIssue('😀'.repeat(64))).toBeNull()
    expect(circleNameIssue('家'.repeat(65))).toBe('range')
    expect(circleNameIssue('   ')).toBe('empty')
    expect(circleNameIssue('  家  ')).toBeNull()
    for (const source of [createSpaceModal, circleGeneral]) {
      expect(source).not.toMatch(/\.length > 64/)
      expect(source).toContain('circleNameIssue(name.value)')
    }
    expect(circleGeneral).toContain("fieldProblems([{ label: '名称', issue: nameIssue.value }])")
    expect(circleGeneral).not.toContain('超出长度')
  })

  it('成员或所有者变了，实例的账号列表才失效；改名不重取', async () => {
    const client = new QueryClient()
    client.setQueryData(['instance-accounts'], { accounts: [] })
    client.setQueryData(['instance-circles'], [])
    await refreshCircles(client)
    expect(client.getQueryState(['instance-accounts'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['instance-circles'])?.isInvalidated).toBe(true)
    await refreshCircles(client, undefined, { accounts: true })
    expect(client.getQueryState(['instance-accounts'])?.isInvalidated).toBe(true)
    expect(circleGeneral).toContain('await refreshCircles(queryClient, circleId.value)\n')
    expect(circleGeneral).toContain(
      'await refreshCircles(queryClient, circleId.value, { accounts: true })',
    )
    expect(
      circleMembers.match(/refreshCircles\(queryClient, circleId\.value, \{ accounts: true \}\)/g),
    ).toHaveLength(3)
  })

  it('记忆圈名超出范围时两处写法一样：完整的一句', () => {
    expect(createSpaceModal).toContain(
      ':error="issue === \'range\' ? CIRCLE_NAME_RANGE : undefined"',
    )
    expect(createSpaceModal).not.toContain('FIELD_ISSUES.range}。')
    expect(circleGeneral).toContain('{{ CIRCLE_NAME_RANGE }}')
  })

  it('首页不在外壳里挂载时不抛错，也不给新建共享圈的按钮', async () => {
    const client = new QueryClient()
    client.setQueryData(ME_KEY, {
      id: '00000000-0000-4000-8000-00000000000a',
      username: 'alice',
      displayName: 'alice',
      isAdmin: true,
      personalCircleId: '00000000-0000-4000-8000-000000000001',
      circles: [],
      ownedSharedCircles: 0,
      maxOwnedCircles: 5,
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'home', component: HomePage }],
    })
    await router.push('/')
    const app = createSSRApp(HomePage)
    app.use(router)
    app.use(VueQueryPlugin, { queryClient: client })
    app.config.warnHandler = () => {}
    const html = await renderToString(app)
    expect(html).toContain('暂无记忆圈')
    expect(html).not.toContain('新建共享圈')
  })

  it('删除前的导出只链给记忆圈所有者，别人写由记忆圈所有者导出', () => {
    expect(circleGeneral).toContain(':can-export="isOwner"')
    expect(instanceCircles).toContain(':can-export="deleting ? ownerOf(deleting.id) : false"')
    expect(instanceCircles).toContain("c.id === circleId && c.role === 'owner'")
    expect(deleteSpaceModal).toContain('删除前先由记忆圈所有者导出。')
  })

  it('新建与导入的入口与弹窗只在外壳里一份，首页经 inject 用它', () => {
    expect(consoleLayout).toContain('provide(NEW_CIRCLE, newCircle)')
    expect(homePage).toContain('useNewCircleEntry()')
    expect(homePage).not.toContain('<CreateSpaceModal')
    expect(homePage).not.toContain('useCreateCircle(')
  })

  it('接口清单里没有旧空间注释或路径', () => {
    expect(endpoints).not.toContain('新建空间时选所有者用')
    expect(endpoints).not.toContain('/spaces')
  })
})
