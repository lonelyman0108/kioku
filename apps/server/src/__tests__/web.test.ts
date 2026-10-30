import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ErrorResponse } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app'
import type { Db } from '../db/client'
import { staticEmbedderSource } from '../embedding/source'

// 模拟一份管理界面的构建产物；这些路由都不访问数据库
const webDir = mkdtempSync(join(tmpdir(), 'kioku-web-'))
mkdirSync(join(webDir, 'assets'))
writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="app"></div>')
writeFileSync(join(webDir, 'assets', 'index-abc.js'), 'console.log(1)')
writeFileSync(join(webDir, 'favicon.svg'), '<svg/>')

const deps = {
  db: {} as Db,
  cookieSecure: true,
  masterKey: null,
  embedder: staticEmbedderSource(null),
  jobs: null,
}
const app = createApp({ ...deps, webDir })

// 和别的错误一样的 { error }，不是纯文本，也不是界面
async function expectApiNotFound(res: Response) {
  expect(res.status).toBe(404)
  expect(res.headers.get('content-type')).toMatch(/^application\/json/)
  expect(ErrorResponse.parse(await res.json()).error).toBe('接口不存在')
}

// 没有匹配的 /v1 路由：路径不存在、只写到 /v1、多写了斜杠、写请求，以及路径对、方法不对
const UNKNOWN_API: [string, RequestInit?][] = [
  ['/v1/nope'],
  ['/v1'],
  ['/v1/'],
  ['//v1/nope'],
  ['/v1/nope', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }],
  ['/v1/health', { method: 'DELETE' }],
]

describe('托管管理界面', () => {
  it('前端路由都返回 index.html，且不缓存', async () => {
    for (const path of ['/', '/login', '/spaces/x/memories']) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<div id="app">')
      expect(res.headers.get('cache-control')).toBe('no-cache')
    }
  })

  it('带哈希的资源长期缓存，根目录的静态文件原样返回', async () => {
    const js = await app.request('/assets/index-abc.js')
    expect(await js.text()).toBe('console.log(1)')
    expect(js.headers.get('cache-control')).toContain('immutable')
    expect(await (await app.request('/favicon.svg')).text()).toBe('<svg/>')
  })

  it('API 不受影响，未知的 /v1 路径是 JSON 的 404「接口不存在」，不是界面', async () => {
    expect((await app.request('/v1/health')).headers.get('content-type')).toContain(
      'application/json',
    )
    for (const [path, init] of UNKNOWN_API) await expectApiNotFound(await app.request(path, init))
    // 只有 /v1 下归 API：前缀相同的别的路径照旧交给前端路由
    expect(await (await app.request('/v1x')).text()).toContain('<div id="app">')
    // 界面的路径收到写请求：照旧是纯文本的 404
    const post = await app.request('/login', { method: 'POST' })
    expect(post.status).toBe(404)
    expect(await post.text()).toBe('404 Not Found')
  })

  it('只提供 API 时（没有界面的构建产物）也一样：未知的 /v1 路径回 JSON，别的路径照旧是纯文本的 404', async () => {
    const apiOnly = createApp(deps)
    for (const [path, init] of UNKNOWN_API) {
      await expectApiNotFound(await apiOnly.request(path, init))
    }
    const page = await apiOnly.request('/login')
    expect(page.status).toBe(404)
    expect(await page.text()).toBe('404 Not Found')
  })

  it('路径穿越拿不到构建目录之外的文件', async () => {
    const res = await app.request('/..%2f..%2fetc%2fpasswd')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('root:')
  })

  it('找不到的资源文件和像文件的路径返回 404，不回退到 index.html', async () => {
    for (const path of [
      '/assets/index-old.js',
      '/missing.png',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await app.request(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('<div id="app">')
    }
  })

  it('响应带安全头，禁止被嵌入别的页面；HSTS 留给前面的 HTTPS 代理决定', async () => {
    const res = await app.request('/')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })
})
