import type { Me } from '@kioku/contracts'
import { QueryClient, QueryObserver, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import endpoints from '../api/endpoints.ts?raw'
import createSpaceModal from '../components/CreateSpaceModal.vue?raw'
import deleteSpaceModal from '../components/DeleteSpaceModal.vue?raw'
import importSpaceModal from '../components/ImportSpaceModal.vue?raw'
import instanceSpaces from '../components/InstanceSpaces.vue?raw'
import spaceGeneral from '../components/SpaceGeneralSettings.vue?raw'
import spaceImport from '../components/SpaceImport.vue?raw'
import spaceMembers from '../components/SpaceMembers.vue?raw'
import spaceTransferSettings from '../components/SpaceTransferSettings.vue?raw'
import useCreateSpace from '../composables/useCreateSpace.ts?raw'
import { useAfterSpaceGone } from '../composables/useLeaveSpace'
import leaveSource from '../composables/useLeaveSpace.ts?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import HomePage from '../pages/HomePage.vue'
import homePage from '../pages/HomePage.vue?raw'
import { ME_KEY, queryClient } from '../query'
import {
  confirmsName,
  DELETE_CONSEQUENCES,
  initialOf,
  isLastOwner,
  LAST_OWNER_NOTE,
  LEAVE_CONSEQUENCES,
  memberAction,
  nextSpace,
  refreshSpaces,
  REMOVE_CONSEQUENCES,
  roleEditable,
  SPACE_LIMIT_KEY,
  spaceLimitNote,
  spaceNameIssue,
  transferTargets,
} from '../spaces'

const owner = { accountId: 'a', role: 'owner' as const }
const editor = { accountId: 'b', role: 'editor' as const }
const viewer = { accountId: 'c', role: 'viewer' as const }

describe('删除空间要输对名字', () => {
  it('逐字一致才能删：多空格、大小写不同、空名都不行', () => {
    expect(confirmsName('家', '家')).toBe(true)
    expect(confirmsName('家 ', '家')).toBe(false)
    expect(confirmsName('home', 'Home')).toBe(false)
    expect(confirmsName('', '')).toBe(false)
  })

  it('弹窗里按钮在名字对上之前不能点，后果写全，链到导入与导出', () => {
    expect(deleteSpaceModal).toContain(':disabled="!matches"')
    expect(deleteSpaceModal).toContain('confirmsName(typed.value, props.spaceName)')
    expect(deleteSpaceModal).toContain("spaceSettingsRoute(spaceId, 'transfer')")
    expect(deleteSpaceModal).not.toContain('<form')
    expect(DELETE_CONSEQUENCES.join('')).toContain('记忆、凭据与访问密钥全部删除')
    expect(DELETE_CONSEQUENCES.join('')).toContain('接入的应用立即失去访问')
  })

  it('空间所有者与实例管理员才有删除；实例的空间列表里删除同样要输入空间名', () => {
    expect(spaceGeneral).toContain('v-if="isOwner || isAdmin"')
    expect(instanceSpaces).toContain('<DeleteSpaceModal')
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

  it('概况里的离开空间在唯一的所有者时不能点，旁边写原因', () => {
    expect(spaceGeneral).toContain(':disabled="lastOwner"')
    expect(spaceGeneral).toContain('lastOwner ? LAST_OWNER_NOTE : LEAVE_NOTE')
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

  it('添加成员只给所有者；成员表不显示本人记忆的条数', () => {
    expect(spaceMembers).toContain('<div v-if="isOwner" class="add-member">')
    expect(spaceMembers).toContain('v-if="roleEditable(viewer, row)"')
    expect(spaceMembers).not.toContain('本人记忆</th>')
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

  const me = (spaces: Me['spaces']): Me => ({
    id: '00000000-0000-4000-8000-00000000000a',
    username: 'alice',
    displayName: 'alice',
    isAdmin: false,
    spaces,
  })

  const GONE = '00000000-0000-4000-8000-0000000000c0'

  async function leaveFrom(
    spaces: Me['spaces'],
    from = `/spaces/${GONE}`,
    observe?: readonly unknown[],
  ) {
    // 取会话时页面已经换到了哪里：要先离开那个空间的页面，再重取
    const routeAtFetch: unknown[] = []
    const fetched = vi.fn(async () => {
      routeAtFetch.push(router.currentRoute.value.name)
      return new Response(JSON.stringify(me(spaces)), { status: 200 })
    })
    vi.stubGlobal('fetch', fetched)
    // 缓存里的会话还有那个空间：跳去哪里按它挑
    queryClient.setQueryData(ME_KEY, me([{ id: GONE, name: '要走的', role: 'owner' }, ...spaces]))
    // 那个空间的查询还在缓存里：离开之后丢掉，不失效重取
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
        { path: '/spaces/:spaceId', name: 'overview', component: { render: () => null } },
        { path: '/settings/instance', name: 'instance', component: { render: () => null } },
      ],
    })
    await router.push(from)
    let afterGone!: (id: string) => Promise<void>
    const app = createSSRApp(
      defineComponent({
        setup() {
          afterGone = useAfterSpaceGone()
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

  it('还有别的空间时去它的概览，会话里的空间列表是新读的', async () => {
    const { route, cached } = await leaveFrom([
      { id: '00000000-0000-4000-8000-0000000000b0', name: '别处', role: 'editor' },
    ])
    expect(route.name).toBe('overview')
    expect(route.params.spaceId).toBe('00000000-0000-4000-8000-0000000000b0')
    expect(cached?.spaces.map((s) => s.id)).toEqual(['00000000-0000-4000-8000-0000000000b0'])
  })

  it('会话只重取一次，那个空间的查询丢掉', async () => {
    const { meRequests, membersLeft } = await leaveFrom([])
    expect(meRequests).toBe(1)
    expect(membersLeft).toBeUndefined()
  })

  it('先离开那个空间的页面，再重取会话、丢掉它的查询', async () => {
    const { routeAtFetch } = await leaveFrom([])
    expect(routeAtFetch).toEqual(['home'])
    const source = leaveSource.slice(leaveSource.indexOf('export function useAfterSpaceGone'))
    expect(source.indexOf('router.replace')).toBeLessThan(source.indexOf('fetchQuery'))
    expect(source.indexOf('fetchQuery')).toBeLessThan(source.indexOf('dropSpaceQueries'))
  })

  it('在实例 › 空间删掉别的空间：留在原页，记住的空间正是它时忘掉；还有组件挂着的查询不丢', async () => {
    const observed = ['space', GONE]
    const { route, membersLeft, observedLeft } = await leaveFrom([], '/settings/instance', observed)
    expect(route.name).toBe('instance')
    expect(membersLeft).toBeUndefined()
    expect(observedLeft).toBeDefined()
    expect(leaveSource).toContain('forgetSpace(spaceId)')
    expect(leaveSource).toContain('if (route.params.spaceId === spaceId)')
    expect(instanceSpaces).toContain('await afterGone(gone.id)')
  })

  it('没有空间了回首页', async () => {
    const { route } = await leaveFrom([])
    expect(route.name).toBe('home')
  })

  it('nextSpace 跳过已经不在的空间', () => {
    const spaces = [
      { id: 'gone', name: 'x', role: 'owner' as const },
      { id: 'b', name: 'y', role: 'viewer' as const },
    ]
    expect(nextSpace(spaces, 'gone')).toBe('b')
    expect(nextSpace(spaces.slice(0, 1), 'gone')).toBeNull()
  })
})

describe('新建空间的入口', () => {
  it('首页没有空间时给新建与导入；名额用完时按钮还在、不可用，下面写原因', () => {
    expect(homePage).toContain('<template v-if="newSpace" #actions>')
    expect(homePage.match(/:disabled="Boolean\(newSpace\.blocked\.value\)"/g)).toHaveLength(2)
    expect(homePage).toContain('@click="newSpace.importing.value = true"')
    expect(homePage).toContain('{{ newSpace.blocked.value }}')
    expect(homePage).toContain('请空间所有者将当前账号加为成员')
    expect(homePage).toContain('<EmptyState')
  })

  it('新建空间只填名称：不选所有者，也不读账号列表', () => {
    expect(createSpaceModal).toContain('api.createSpace({ name: trimmed.value })')
    expect(createSpaceModal).not.toContain('ownerAccountId')
    expect(createSpaceModal).not.toContain('api.accounts')
    expect(instanceSpaces).not.toContain('CreateSpaceModal')
    expect(instanceSpaces).not.toContain('SpaceImport')
  })

  it('名额的说明：用完才有，写出上限是几个；没读到时不拦', () => {
    expect(spaceLimitNote(undefined)).toBeNull()
    expect(spaceLimitNote({ maxOwnedSpaces: 5, ownedSpaces: 4, canCreate: true })).toBeNull()
    expect(spaceLimitNote({ maxOwnedSpaces: 5, ownedSpaces: 5, canCreate: false })).toBe(
      '已达空间数量上限（5 个）',
    )
  })

  it('空间与成员变了，名额跟着重取：新建、导入、删除、离开、转让都经 refreshSpaces', async () => {
    const client = new QueryClient()
    client.setQueryData(SPACE_LIMIT_KEY, { maxOwnedSpaces: 5, ownedSpaces: 1, canCreate: true })
    await refreshSpaces(client)
    expect(client.getQueryState(SPACE_LIMIT_KEY)?.isInvalidated).toBe(true)
    expect(spaceImport).toContain('await refreshSpaces(queryClient, undefined, { accounts: true })')
    expect(useCreateSpace).toContain(
      'await refreshSpaces(queryClient, undefined, { accounts: true })',
    )
    expect(leaveSource).toContain(
      'refreshSpaces(queryClient, undefined, { me: false, accounts: true })',
    )
  })

  it('实例 › 空间：上限是一项数值设置，放在表单里，范围取契约的常量；列表只读、只能删除', () => {
    expect(instanceSpaces).toContain('<form v-else-if="limit.data.value" @submit.prevent="save">')
    expect(instanceSpaces).toContain('schema: MaxOwnedSpaces')
    expect(instanceSpaces).toContain(
      '请填写 {{ SPACE_LIMIT_MIN }} 到 {{ SPACE_LIMIT_MAX }} 之间的整数。',
    )
    expect(instanceSpaces).toContain('<SaveBar')
    expect(instanceSpaces).toContain('queryClient.setQueryData(SPACE_LIMIT_KEY, view)')
    expect(instanceSpaces).not.toContain('USwitch')
    expect(instanceSpaces).not.toContain('icons.add')
  })

  it('导入空间的弹窗：检查、导入期间不能关；导入的表单在设置里与弹窗里是同一个组件', () => {
    expect(importSpaceModal).toContain(':dismissible="!busy"')
    expect(importSpaceModal).toContain('<SpaceImport v-model:busy="busy" bare')
    expect(spaceTransferSettings).toContain('<SpaceImport />')
    // 主密钥的状态只有实例管理员读得到，别的账号不发这个请求
    expect(spaceImport).toContain('enabled: computed(() => me.data.value?.isAdmin ?? false)')
  })
})

describe('审查修复', () => {
  it('空间名按码点数长度，和服务端同一个 schema；问题文字走 fieldProblems', () => {
    expect(spaceNameIssue('😀'.repeat(40))).toBeNull()
    expect(spaceNameIssue('😀'.repeat(64))).toBeNull()
    expect(spaceNameIssue('家'.repeat(65))).toBe('range')
    expect(spaceNameIssue('   ')).toBe('empty')
    expect(spaceNameIssue('  家  ')).toBeNull()
    for (const source of [createSpaceModal, spaceGeneral]) {
      expect(source).not.toMatch(/\.length > 64/)
      expect(source).toContain('spaceNameIssue(name.value)')
    }
    expect(spaceGeneral).toContain("fieldProblems([{ label: '名称', issue: nameIssue.value }])")
    expect(spaceGeneral).not.toContain('超出长度')
  })

  it('成员或所有者变了，实例的账号列表（所在空间、唯一可用的所有者）才失效；改名不重取', async () => {
    const client = new QueryClient()
    client.setQueryData(['instance-accounts'], { accounts: [] })
    client.setQueryData(['instance-spaces'], [])
    await refreshSpaces(client)
    expect(client.getQueryState(['instance-accounts'])?.isInvalidated).toBe(false)
    expect(client.getQueryState(['instance-spaces'])?.isInvalidated).toBe(true)
    await refreshSpaces(client, undefined, { accounts: true })
    expect(client.getQueryState(['instance-accounts'])?.isInvalidated).toBe(true)
    // 改名不传，转让传
    expect(spaceGeneral).toContain('await refreshSpaces(queryClient, spaceId.value)\n')
    expect(spaceGeneral).toContain(
      'await refreshSpaces(queryClient, spaceId.value, { accounts: true })',
    )
    expect(
      spaceMembers.match(/refreshSpaces\(queryClient, spaceId.value, \{ accounts: true \}\)/g),
    ).toHaveLength(3)
  })

  it('空间名超出范围时两处写法一样：完整的一句', () => {
    expect(createSpaceModal).toContain(
      ':error="issue === \'range\' ? SPACE_NAME_RANGE : undefined"',
    )
    expect(createSpaceModal).not.toContain('FIELD_ISSUES.range}。')
    expect(spaceGeneral).toContain('{{ SPACE_NAME_RANGE }}')
  })

  it('首页不在外壳里挂载时不抛错，也不给新建空间的按钮', async () => {
    const client = new QueryClient()
    client.setQueryData(ME_KEY, {
      id: '00000000-0000-4000-8000-00000000000a',
      username: 'alice',
      displayName: 'alice',
      isAdmin: true,
      spaces: [],
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
    expect(html).toContain('暂无空间')
    expect(html).not.toContain('新建空间')
  })

  it('删除前的导出只链给空间所有者，别人写由所有者导出', () => {
    expect(spaceGeneral).toContain(':can-export="isOwner"')
    expect(instanceSpaces).toContain(':can-export="deleting ? ownerOf(deleting.id) : false"')
    expect(instanceSpaces).toContain("s.id === spaceId && s.role === 'owner'")
    expect(deleteSpaceModal).toContain('删除前先由空间所有者导出。')
  })

  it('新建空间的入口与弹窗只在外壳里一份，首页经 inject 用它', () => {
    expect(consoleLayout).toContain('provide(NEW_SPACE, newSpace)')
    expect(homePage).toContain('useNewSpaceEntry()')
    expect(homePage).not.toContain('<CreateSpaceModal')
    expect(homePage).not.toContain('useCreateSpace(')
  })

  it('接口清单里没有悬空的注释', () => {
    expect(endpoints).not.toContain('新建空间时选所有者用')
  })
})
