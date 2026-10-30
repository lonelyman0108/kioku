import { LAYERS, type CreatedKey, type KeyScopes, type Me } from '@kioku/contracts'

import { createSession } from '../auth/session'
import type { createApp } from '../app'
import type { Db } from '../db/client'
import { accounts, spaceMembers } from '../db/schema'

type App = ReturnType<typeof createApp>

export const FULL_SCOPES: KeyScopes = {
  readLayers: [...LAYERS],
  writeLayers: [...LAYERS],
  maxSensitivity: 'secret',
  admin: false,
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
  spaceId: string
  accountId: string
  createApp: (slug: string, extra?: Record<string, unknown>) => Promise<{ id: string }>
  createPersona: (slug: string, extendsId?: string) => Promise<{ id: string }>
  issueKey: (appId: string, scopes?: KeyScopes) => Promise<string>
  // 要 Key 的 id 时用它（测试台按 id 模拟）；key 是明文
  createKey: (appId: string, scopes?: KeyScopes) => Promise<CreatedKey>
}

// 初始化一个账号和空间，返回在其中建应用、人格、签发 Key 的快捷方法
export async function bootstrap(app: App, username = 'alice'): Promise<Workspace> {
  const res = await app.request(
    '/v1/setup',
    jsonRequest('POST', {
      username,
      displayName: username,
      password: 'correct horse battery',
      spaceName: '家',
    }),
  )
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!
  const me = await expectOk<Me>(res)
  const spaceId = me.spaces[0]!.id
  const withCookie = { cookie }
  const createKey = async (appId: string, scopes: KeyScopes = FULL_SCOPES) =>
    expectOk<CreatedKey>(
      await app.request(
        `/v1/spaces/${spaceId}/apps/${appId}/keys`,
        jsonRequest('POST', { name: 'test', scopes }, withCookie),
      ),
    )
  return {
    cookie,
    spaceId,
    accountId: me.id,
    createApp: async (slug, extra = {}) =>
      expectOk(
        await app.request(
          `/v1/spaces/${spaceId}/apps`,
          jsonRequest('POST', { slug, name: slug, runtimeFamily: 'mcp', ...extra }, withCookie),
        ),
      ),
    createPersona: async (slug, extendsId) =>
      expectOk(
        await app.request(
          `/v1/spaces/${spaceId}/personas`,
          jsonRequest('POST', { slug, name: slug, extendsId: extendsId ?? null }, withCookie),
        ),
      ),
    issueKey: async (appId, scopes = FULL_SCOPES) => (await createKey(appId, scopes)).key,
    createKey,
  }
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` })

// 往空间里直接加一个成员（还没有邀请接口），返回它的会话 Cookie
export async function addMember(
  db: Db,
  spaceId: string,
  username: string,
  role: 'owner' | 'editor' | 'viewer',
): Promise<{ accountId: string; cookie: string }> {
  const [account] = await db
    .insert(accounts)
    .values({ username, displayName: username, passwordHash: 'x' })
    .returning()
  await db.insert(spaceMembers).values({ spaceId, accountId: account!.id, role })
  return { accountId: account!.id, cookie: `kioku_session=${await createSession(db, account!.id)}` }
}
