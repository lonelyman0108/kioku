import { ENTRY_KINDS, LensKeyScopes, type IssuedKey, type Me } from '@kioku/contracts'
import type { z } from 'zod'

import { createPersonalCircle } from '../access/circles'
import { createSession } from '../auth/session'
import type { createApp } from '../app'
import type { Db } from '../db/client'
import { accounts, circleMembers } from '../db/schema'

type App = ReturnType<typeof createApp>
// 签发时的上限：凭据能力不给就是不可用
type KeyScopesInput = z.input<typeof LensKeyScopes>

export const FULL_SCOPES: LensKeyScopes = {
  readKinds: [...ENTRY_KINDS],
  writeKinds: [...ENTRY_KINDS],
  maxSensitivity: 'secret',
  allowedRealms: null,
  admin: false,
  credentials: 'manage',
}

// 模拟浏览器的同源请求
const sameSite = { 'sec-fetch-site': 'same-origin' }

export function jsonRequest(method: string, body: unknown, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...sameSite, ...headers },
    body: JSON.stringify(body),
  }
}

async function expectOk<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export interface Workspace {
  cookie: string
  circleId: string
  personalCircleId: string
  accountId: string
  createClient: (slug: string, extra?: Record<string, unknown>) => Promise<{ id: string }>
  createPersona: (slug: string, extendsId?: string) => Promise<{ id: string }>
  issueKey: (clientId: string, scopes?: KeyScopesInput) => Promise<string>
  // 要 Key 的 id 时用它（测试台按 id 模拟）；key 是明文
  createKey: (clientId: string, scopes?: KeyScopesInput) => Promise<IssuedKey>
}

// 初始化一个账号和记忆圈，返回在其中建客户端、人格、签发 Key 的快捷方法
export async function bootstrap(app: App, username = 'alice'): Promise<Workspace> {
  const res = await app.request(
    '/v1/setup',
    jsonRequest('POST', {
      // 测试里的应用不带初始化码的核对（Deps.setup 不设），码随便填
      setupCode: 'test-setup-code',
      username,
      displayName: username,
      password: 'correct horse battery',
      circleName: '家',
    }),
  )
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  const me = await expectOk<Me>(res)
  const circleId = me.circles.find((c) => c.kind === 'shared')!.id
  const personalCircleId = me.personalCircleId
  const withCookie = { cookie }
  const createKey = async (clientId: string, scopes: KeyScopesInput = FULL_SCOPES) =>
    expectOk<IssuedKey>(
      await app.request(
        `/v1/circles/${circleId}/clients/${clientId}/keys`,
        jsonRequest('POST', { name: 'test', scopes }, withCookie),
      ),
    )
  return {
    cookie,
    circleId,
    personalCircleId,
    accountId: me.id,
    createClient: async (slug, extra = {}) =>
      expectOk(
        await app.request(
          `/v1/circles/${circleId}/clients`,
          jsonRequest('POST', { slug, name: slug, runtimeFamily: 'mcp', ...extra }, withCookie),
        ),
      ),
    createPersona: async (slug, extendsId) =>
      expectOk(
        await app.request(
          `/v1/circles/${circleId}/personas`,
          jsonRequest('POST', { slug, name: slug, extendsId: extendsId ?? null }, withCookie),
        ),
      ),
    issueKey: async (clientId, scopes = FULL_SCOPES) => (await createKey(clientId, scopes)).key,
    createKey,
  }
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

// 往记忆圈里直接加一个成员（同时补齐其唯一个人圈），返回它的会话 Cookie
export async function addMember(
  db: Db,
  circleId: string,
  username: string,
  role: 'owner' | 'editor' | 'viewer',
): Promise<{ accountId: string; personalCircleId: string; cookie: string }> {
  const created = await db.transaction(async (tx) => {
    const [account] = await tx
      .insert(accounts)
      .values({ username, displayName: username, passwordHash: 'x' })
      .returning()
    const personal = await createPersonalCircle(tx, account!)
    await tx.insert(circleMembers).values({ circleId, accountId: account!.id, role })
    return { accountId: account!.id, personalCircleId: personal.id }
  })
  return {
    accountId: created.accountId,
    personalCircleId: created.personalCircleId,
    cookie: `kioku_session=${await createSession(db, created.accountId)}`,
  }
}
