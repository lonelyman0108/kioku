import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const app = createApp({
  db: {} as Db,
  cookieSecure: true,
  masterKey: null,
  embedder: staticEmbedderSource(null),
  jobs: null,
  webDir,
})

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

  it('API 不受影响，未知的 /v1 路径仍是 404 而不是界面', async () => {
    expect((await app.request('/v1/health')).headers.get('content-type')).toContain(
      'application/json',
    )
    const missing = await app.request('/v1/nope')
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain('<div id="app">')
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
