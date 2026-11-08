import type { AdminAccount } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

import {
  accountStates,
  accountStateText,
  changePasswordError,
  deviceName,
  expiresIn,
  linkLoadState,
  newPasswordProblem,
  newPasswordReady,
  passwordLinkUrl,
  SELF_LOCKED_REASON,
  setPasswordError,
  soleOwnerSpaces,
} from '../accounts'
import { ApiError } from '../api/client'
import accountLogin from '../components/AccountLoginSettings.vue?raw'
import instanceAccounts from '../components/InstanceAccounts.vue?raw'
import passwordLinkOnce from '../components/PasswordLinkOnce.vue?raw'
import consoleLayout from '../layouts/ConsoleLayout.vue?raw'
import passwordPage from '../pages/PasswordPage.vue?raw'
import routes from '../routes.ts?raw'

interface TemplateNode {
  type: number
  tag?: string
  children?: TemplateNode[]
  props?: {
    type: number
    name: string
    value?: { content: string }
    arg?: { content: string }
    exp?: { content: string }
  }[]
}
const ELEMENT = 1
const elementsOf = (source: string): TemplateNode[] => {
  const walk = (node: TemplateNode): TemplateNode[] => [
    ...(node.type === ELEMENT ? [node] : []),
    ...(node.children ?? []).flatMap(walk),
  ]
  return walk(parse(source).descriptor.template!.ast as unknown as TemplateNode)
}
const bound = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.name === 'bind' && p.arg?.content === name)?.exp?.content
const attr = (el: TemplateNode, name: string) =>
  el.props?.find((p) => p.type === 6 && p.name === name)?.value?.content
const handler = (el: TemplateNode, event: string) =>
  el.props?.find((p) => p.name === 'on' && p.arg?.content === event)?.exp?.content

const NOW = new Date('2026-11-08T12:00:00Z')
const account = (changes: Partial<AdminAccount> = {}): AdminAccount => ({
  id: '00000000-0000-4000-8000-000000000001',
  username: 'bob',
  displayName: 'Bob',
  isAdmin: false,
  passwordSet: true,
  disabledAt: null,
  createdAt: NOW.toISOString(),
  lastActiveAt: null,
  spaces: [],
  pendingLink: null,
  ...changes,
})
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString()

describe('设置密码链接只显示一次', () => {
  it('链接是完整地址：站点地址拼 /password/<令牌>', () => {
    expect(passwordLinkUrl('abc_-123', 'https://kioku.example.com')).toBe(
      'https://kioku.example.com/password/abc_-123',
    )
    expect(passwordLinkUrl('a/b', 'https://kioku.example.com')).toBe(
      'https://kioku.example.com/password/a%2Fb',
    )
  })

  it('新建账号与重新生成链接：链接显示期间不能点遮罩、按 Esc 或右上角关掉', () => {
    const modals = elementsOf(instanceAccounts).filter((el) => el.tag === 'UModal')
    const create = modals.find((m) => bound(m, 'title')?.includes("'新建账号'"))!
    expect(bound(create, 'dismissible')).toBe('!created')
    expect(bound(create, 'close')).toBe('!created')
    const regenerate = modals.find((m) => bound(m, 'title')?.includes("'重新生成链接？'"))!
    expect(bound(regenerate, 'dismissible')).toBe('!regenerated')
    expect(bound(regenerate, 'close')).toBe('!regenerated')
    // 关掉之后明文就清了，再打开看不到
    expect(instanceAccounts).toMatch(/function closeCreate\(\) \{[^}]*created\.value = null/)
    expect(instanceAccounts).toMatch(/function closeLink\(\) \{[^}]*regenerated\.value = null/)
  })

  it('链接页写明只显示这一次与有效期，可以复制', () => {
    expect(passwordLinkOnce).toContain('只显示这一次')
    expect(passwordLinkOnce).toContain('LINK_ONCE_TEXT')
    expect(passwordLinkOnce).toContain('aria-label="复制链接"')
  })

  it('新建账号的弹窗不用表单：建好之后回车不会再建一个', () => {
    expect(elementsOf(instanceAccounts).some((el) => el.tag === 'form')).toBe(false)
  })
})

describe('账号列表', () => {
  it('状态：正常、待设置密码与过期时间、已停用', () => {
    expect(accountStates(account(), NOW).map(accountStateText)).toEqual(['正常'])
    expect(
      accountStates(
        account({
          passwordSet: false,
          pendingLink: { purpose: 'setup', expiresAt: inHours(22.5) },
        }),
        NOW,
      ).map(accountStateText),
    ).toEqual(['待设置密码 · 23 小时后过期'])
    expect(accountStates(account({ passwordSet: false }), NOW).map(accountStateText)).toEqual([
      '待设置密码 · 链接已过期',
    ])
    expect(
      accountStates(account({ pendingLink: { purpose: 'reset', expiresAt: inHours(1) } }), NOW).map(
        accountStateText,
      ),
    ).toEqual(['正常', '待重置密码 · 1 小时后过期'])
    expect(
      accountStates(
        account({ disabledAt: NOW.toISOString(), pendingLink: null, passwordSet: false }),
        NOW,
      ).map((s) => s.status),
    ).toEqual(['accountDisabled'])
    expect(expiresIn(inHours(0.25), NOW)).toBe('15 分钟后过期')
  })

  it('当前账号这一行：停用与管理员操作禁用并写原因', () => {
    const buttons = elementsOf(instanceAccounts).filter((el) => el.tag === 'UButton')
    for (const action of ['admin', 'disable']) {
      const button = buttons.find((b) => attr(b, 'data-action') === action)!
      expect(bound(button, 'disabled')).toBe('account.id === selfId')
    }
    expect(instanceAccounts).toContain('SELF_LOCKED_REASON')
    expect(SELF_LOCKED_REASON).toBe('无法修改当前账号的停用状态与管理员身份')
  })

  it('停用的确认写出后果；唯一可用所有者的空间单独列出', () => {
    expect(instanceAccounts).toContain(
      '停用后：无法登录，会话立即失效，其应用的访问密钥停止工作；重新启用后恢复。',
    )
    const spaces = [
      { id: '00000000-0000-4000-8000-000000000002', name: '家', role: 'owner' as const },
      { id: '00000000-0000-4000-8000-000000000003', name: '工作', role: 'owner' as const },
    ]
    const flagged = account({
      spaces: [{ ...spaces[0]!, soleOwner: true } as (typeof spaces)[number], spaces[1]!],
    })
    expect(soleOwnerSpaces(flagged)).toEqual(['家'])
    expect(soleOwnerSpaces(account({ spaces }))).toEqual([])
  })

  it('修改失败按服务端的说明显示（保留最后一个管理员等）', () => {
    expect(instanceAccounts).toContain("err instanceof ApiError ? err.message : '修改失败'")
  })
})

describe('账号与登录', () => {
  it('改密码的错误分开说明', () => {
    expect(changePasswordError(new ApiError(400, '当前密码错误'))).toBe('当前密码错误')
    expect(changePasswordError(new ApiError(429, '失败次数过多，请稍后重试'))).toBe(
      '尝试次数过多，请稍后重试',
    )
    expect(changePasswordError(new ApiError(409, 'x'))).toBe('密码刚在别处修改过，请刷新页面后重试')
    expect(changePasswordError(new TypeError('x'))).toBe('修改失败')
  })

  it('新密码至少 10 位、两次一致才能提交', () => {
    expect(newPasswordProblem('short', '')).toBe('密码至少 10 位')
    expect(newPasswordProblem('long enough!', 'long enough?')).toBe('两次输入的密码不一致')
    expect(newPasswordReady('long enough!', 'long enough!')).toBe(true)
    expect(newPasswordReady('long enough!', '')).toBe(false)
  })

  it('设备名：认出浏览器与系统，认不出写原文的开头', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome · macOS')
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari · iOS')
    expect(
      deviceName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
      ),
    ).toBe('Edge · Windows')
    expect(deviceName('curl/8.7.1')).toBe('curl/8.7.1')
    expect(deviceName(`kioku-cli ${'x'.repeat(60)}`)).toBe(`kioku-cli ${'x'.repeat(30)}…`)
    expect(deviceName(null)).toBe('未知设备')
  })

  it('退出当前设备走外壳的退出流程，其他设备单独退出', () => {
    expect(accountLogin).toMatch(/if \(session\.current\) \{\s*await logout\(\)/)
    expect(accountLogin).toContain('api.signOutSession(session.id)')
    expect(accountLogin).toContain('api.signOutOtherSessions()')
    expect(accountLogin).toContain('useLogout()')
    expect(consoleLayout).toContain('provide(LOGOUT, logout)')
    const button = elementsOf(accountLogin).find(
      (el) => el.tag === 'UButton' && handler(el, 'click') === 'signOut(session)',
    )
    expect(button).toBeDefined()
  })

  it('改密码成功后提示其他设备需要重新登录', () => {
    expect(accountLogin).toContain("description: '其他设备需要重新登录。'")
  })
})

describe('设置密码页', () => {
  it('不需要登录', () => {
    expect(routes).toContain("path: '/password/:token'")
    expect(routes.indexOf("if (to.name === 'password') return true")).toBeLessThan(
      routes.indexOf('const me = await loadMe()'),
    )
  })

  it('三种状态：可用、无效或过期、读取失败', () => {
    expect(linkLoadState(new ApiError(404, '链接无效或已过期'))).toBe('invalid')
    expect(linkLoadState(new ApiError(500, 'x'))).toBe('failed')
    expect(linkLoadState(new TypeError('x'))).toBe('failed')
    const states = elementsOf(passwordPage)
      .map((el) => attr(el, 'data-state'))
      .filter(Boolean)
    expect(states).toEqual(['invalid', 'failed', 'ready'])
    expect(passwordPage).toContain('请联系实例管理员重新生成链接。')
  })

  it('设置失败：链接失效转到无效状态，尝试太多单独说明', () => {
    expect(setPasswordError(new ApiError(404, 'x'))).toEqual({
      text: '链接无效或已过期',
      invalid: true,
    })
    expect(setPasswordError(new ApiError(429, 'x'))).toEqual({
      text: '尝试次数过多，请稍后重试',
      invalid: false,
    })
  })

  it('写清给谁设置；设好之后换成这个账号、清掉缓存', () => {
    expect(passwordPage).toContain('`为 ${i.displayName}（${i.username}）设置密码`')
    expect(passwordPage).toContain('`重置 ${i.displayName} 的密码`')
    expect(passwordPage).toMatch(/queryClient\.clear\(\)\s*queryClient\.setQueryData\(ME_KEY, me\)/)
  })
})
