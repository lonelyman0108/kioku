import { LAYERS, type CreatedKey, type KeyScopes, type Me } from '@kioku/contracts'

import type { createApp } from '../app'

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
    issueKey: async (appId, scopes = FULL_SCOPES) =>
      (
        await expectOk<CreatedKey>(
          await app.request(
            `/v1/spaces/${spaceId}/apps/${appId}/keys`,
            jsonRequest('POST', { name: 'test', scopes }, withCookie),
          ),
        )
      ).key,
  }
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
