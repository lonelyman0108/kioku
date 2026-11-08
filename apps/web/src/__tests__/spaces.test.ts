import type { Me } from '@kioku/contracts'
import { QueryClient } from '@tanstack/vue-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'

import endpoints from '../api/endpoints.ts?raw'
import createSpaceModal from '../components/CreateSpaceModal.vue?raw'
import deleteSpaceModal from '../components/DeleteSpaceModal.vue?raw'
import instanceSpaces from '../components/InstanceSpaces.vue?raw'
import spaceGeneral from '../components/SpaceGeneralSettings.vue?raw'
import spaceMembers from '../components/SpaceMembers.vue?raw'
import { useAfterSpaceGone } from '../composables/useLeaveSpace'
import leaveSource from '../composables/useLeaveSpace.ts?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
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

  async function leaveFrom(spaces: Me['spaces'], from = `/spaces/${GONE}`) {
    const fetched = vi.fn(async () => new Response(JSON.stringify(me(spaces)), { status: 200 }))
    vi.stubGlobal('fetch', fetched)
    // 那个空间的查询还在缓存里：离开之后丢掉，不失效重取
    queryClient.setQueryData(['members', GONE], [])
    const router = createRouter({
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
    return {
      route: router.currentRoute.value,
      cached: queryClient.getQueryData<Me>(ME_KEY),
      meRequests: fetched.mock.calls.length,
      membersLeft: queryClient.getQueryState(['members', GONE]),
    }
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

  it('在实例 › 空间删掉别的空间：留在原页，记住的空间正是它时忘掉', async () => {
    const { route } = await leaveFrom([], '/settings/instance')
    expect(route.name).toBe('instance')
    expect(leaveSource).toContain('forgetSpace(spaceId)')
    expect(leaveSource).toContain('if (route.params.spaceId !== spaceId) return')
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
  it('首页没有空间时：能新建才给按钮，否则写下一步', () => {
    expect(homePage).toContain('<template v-if="newSpace.canCreate.value" #actions>')
    expect(homePage).toContain('请空间所有者将当前账号加为成员')
    expect(homePage).toContain('<EmptyState')
  })

  it('实例管理员新建时选所有者，默认当前账号，停用的账号不列', () => {
    expect(instanceSpaces).toContain('choose-owner')
    expect(createSpaceModal).toContain('.filter((a) => !a.disabledAt)')
    expect(createSpaceModal).toContain('owner.value = props.currentAccountId')
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

  it('空间变了，实例的账号列表（所在空间、唯一可用的所有者）也失效', async () => {
    const client = new QueryClient()
    client.setQueryData(['instance-accounts'], { accounts: [] })
    client.setQueryData(['instance-spaces'], [])
    await refreshSpaces(client)
    expect(client.getQueryState(['instance-accounts'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['instance-spaces'])?.isInvalidated).toBe(true)
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
