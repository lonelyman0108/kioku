import { randomBytes } from 'node:crypto'

import {
  ConsoleEntryView,
  EntryWriteError,
  type EntryHistory,
  type InboxCounts,
  type IssuedKey,
} from '@kioku/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../app'
import type { Database } from '../../db/client'
import { staticEmbedderSource } from '../../embedding/source'
import type { Deps } from '../../http/env'
import { consoleCircleFor, type EntryContext } from '../../memory/entryContext'
import { EntryService } from '../../memory/service'
import { openTestDatabase, resetDatabase, testDatabaseUrl } from '../../testing/db'
import {
  addMember,
  bearer,
  bootstrap,
  FULL_SCOPES,
  jsonRequest,
  type Workspace,
} from '../../testing/fixtures'
import { sampleToken, TOKEN_SAMPLES } from '../../testing/plaintext'

describe.skipIf(!testDatabaseUrl)('写入前拦截新增的疑似明文', () => {
  let database: Database
  let app: ReturnType<typeof createApp>
  let ws: Workspace
  let key: string
  const masterKey = randomBytes(32)
  const deps = () =>
    ({
      db: database.db,
      masterKey,
      jobs: null,
      embedder: staticEmbedderSource(null),
    }) as unknown as Deps

  beforeAll(async () => {
    database = await openTestDatabase()
    app = createApp({
      db: database.db,
      cookieSecure: false,
      masterKey,
      embedder: staticEmbedderSource(null),
      jobs: null,
    })
  })
  afterAll(async () => {
    await database?.close()
  })
  beforeEach(async () => {
    await resetDatabase(database)
    ws = await bootstrap(app)
    const clientRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients`,
      jsonRequest(
        'POST',
        { slug: 'claude-code', name: 'claude-code', runtimeFamily: 'mcp' },
        { cookie: ws.cookie },
      ),
    )
    expect(clientRes.status).toBe(201)
    const client = (await clientRes.json()) as { id: string }
    const keyRes = await app.request(
      `/v1/circles/${ws.personalCircleId}/clients/${client.id}/keys`,
      jsonRequest('POST', { name: 'test', scopes: FULL_SCOPES }, { cookie: ws.cookie }),
    )
    expect(keyRes.status).toBe(201)
    key = ((await keyRes.json()) as IssuedKey).key
  })

  // 通过 Key 的 REST（主场圈为个人圈，支持 secret 词条）
  const viaKey = (method: string, body: unknown) =>
    app.request('/v1/entries', jsonRequest(method, body, bearer(key)))
  // 管理界面
  const viaConsole = (
    method: string,
    body: unknown,
    cookie = ws.cookie,
    circleId = ws.personalCircleId,
  ) => app.request(`/v1/circles/${circleId}/entries`, jsonRequest(method, body, { cookie }))
  const consoleGet = (path: string, circleId = ws.personalCircleId) =>
    app.request(`/v1/circles/${circleId}${path}`, { headers: { cookie: ws.cookie } })
  const rejected = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(400)
    return EntryWriteError.parse(await res.json())
  }
  const ok = async (res: Response, status = 200) => {
    expect(res.status, await res.clone().text()).toBe(status)
    return (await res.json()) as ConsoleEntryView
  }
  const inbox = async (circleId = ws.personalCircleId) =>
    ((await (await consoleGet('/inbox/counts', circleId)).json()) as InboxCounts).plaintext

  let id = 0
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const res = await app.request('/v1/mcp', {
      method: 'POST',
      headers: {
        ...bearer(key),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const body = (await res.json()) as {
      result: { content: { text: string }[]; isError?: boolean }
    }
    return { text: body.result.content[0]!.text, isError: body.result.isError ?? false }
  }

  describe('Key 的写入', () => {
    it('新建：正文里有疑似明文时拒绝，指出第几行、哪一类，不带值，什么都没写', async () => {
      const token = sampleToken('github')
      const content = `NAS 的说明\n管理员密码：hunter2\n部署用 ${token}`
      const err = await rejected(await viaKey('POST', { title: 'NAS', content }))
      expect(err.plaintext).toEqual([
        { line: 2, kind: 'label' },
        { line: 3, kind: 'github' },
      ])
      expect(err.error).toContain('第 2 行（标注的密码或令牌）')
      expect(err.error).toContain('第 3 行（GitHub 令牌）')
      expect(err.error).toContain('kioku_credential_save')
      expect(err.error).toContain('plaintext_ok')
      expect(err.error).not.toContain('hunter2')
      expect(err.error).not.toContain(token.slice(4))
      expect((await app.request('/v1/entries?id=NAS', { headers: bearer(key) })).status).toBe(404)
    })

    it('每一类令牌都拦', async () => {
      for (const [i, { name, kind, token }] of TOKEN_SAMPLES.entries()) {
        const err = await rejected(
          await viaKey('POST', { title: `tok-${i}`, content: `说明\n${token}` }),
        )
        expect(err.plaintext, name).toEqual([{ line: 2, kind }])
      }
    })

    it('值以中文开头的、盖过的、太短的令牌不拦；结果是机密的不拦', async () => {
      for (const [i, content] of [
        '密码：见 Vaultwarden 条目',
        '密码：***',
        `部署用 ${sampleToken('sk').slice(0, 10)}`,
      ].entries()) {
        await ok(await viaKey('POST', { title: `ok-${i}`, content }), 201)
      }
      await ok(
        await viaKey('POST', {
          title: 'secret-entry',
          content: '密码：hunter2',
          sensitivity: 'secret',
        }),
        201,
      )
    })

    it('修改：只拦新增的值；已有的疑似明文不挡修改，只改元数据不查', async () => {
      const wifi = await ok(
        await viaKey('POST', {
          title: 'wifi',
          content: '密码：hunter2',
          plaintextOk: true,
        }),
        201,
      )
      // 只改元数据
      await ok(await viaKey('PATCH', { id: wifi.shortId, priority: 1 }))
      // 正文改了，但疑似明文还是原来那个值，挪了位置、换了写法也一样
      await ok(
        await viaKey('PATCH', {
          id: wifi.shortId,
          content: '访客网络\ntoken = hunter2',
        }),
      )
      // 新的值
      const err = await rejected(
        await viaKey('PATCH', {
          id: wifi.shortId,
          content: '访客网络\ntoken = hunter2\n新密码：hunter3',
        }),
      )
      expect(err.plaintext).toEqual([{ line: 3, kind: 'label' }])
    })

    it('带 plaintextOk 照常写入，进待处理；不放行从机密降级', async () => {
      expect(await inbox()).toBe(0)
      const view = await ok(
        await viaKey('POST', {
          title: 'demo',
          content: '示例配置：password = example',
          plaintextOk: true,
        }),
        201,
      )
      expect(view.variants[0]!.content).toBe('示例配置：password = example')
      expect(await inbox()).toBe(1)
      const locked = await ok(
        await viaKey('POST', {
          title: 'locked',
          content: '密码：hunter2',
          sensitivity: 'secret',
        }),
        201,
      )
      const res = await viaKey('PATCH', {
        id: locked.shortId,
        sensitivity: 'private',
        plaintextOk: true,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('降级')
    })

    it('写入后是机密的不拦：新建成机密、修改成机密，正文带令牌也照常写入', async () => {
      let c0!: ConsoleEntryView
      for (const [i, { name, token }] of TOKEN_SAMPLES.entries()) {
        const kEntry = await ok(
          await viaKey('POST', {
            title: `k-${i}`,
            content: `说明\n${token}`,
            sensitivity: 'secret',
          }),
          201,
        )
        const cEntry = await ok(
          await viaConsole('POST', { title: `c-${i}`, content: '普通的说明' }),
          201,
        )
        const cUpd = await ok(
          await viaConsole('PATCH', {
            id: cEntry.id,
            content: `说明\n${token}`,
            sensitivity: 'secret',
          }),
        )
        if (i === 0) c0 = cUpd
        // 已经是机密的，改正文时也不拦
        const res = await viaKey('PATCH', {
          id: kEntry.shortId,
          content: `说明\n${token}\n${token.replace(/[0-9]/g, '7')}`,
        })
        expect(res.status, name).toBe(200)
      }
      // 从机密改低照旧拦，带着明文降级要记忆圈所有者确认
      const res = await viaConsole('PATCH', { id: c0.id, sensitivity: 'private' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('降级')
      expect(await inbox()).toBe(0)
    })

    it('ignorePlaintext 与 allowPlaintext 只给管理界面：Key 的请求里去掉，照样拦', async () => {
      const x = await ok(await viaKey('POST', { title: 'note-x', content: '普通的说明' }), 201)
      for (const flag of ['ignorePlaintext', 'allowPlaintext']) {
        const create = await viaKey('POST', {
          title: 'note-y',
          content: '密码：hunter2',
          [flag]: true,
        })
        expect((await rejected(create)).plaintext, flag).toEqual([{ line: 1, kind: 'label' }])
        const update = await viaKey('PATCH', {
          id: x.shortId,
          content: '密码：hunter2',
          [flag]: true,
        })
        expect((await rejected(update)).plaintext, flag).toEqual([{ line: 1, kind: 'label' }])
      }
      // 不带疑似明文的修改照常写入：标记去掉了，不报错
      await ok(await viaKey('PATCH', { id: x.shortId, priority: 1, allowPlaintext: true }))
    })

    it('MCP：被拒时工具报错，说明第几行、哪一类；带 plaintext_ok 照常写入，结果里不再提醒', async () => {
      const content = `部署用 ${sampleToken('sk')}`
      const denied = await callTool('kioku_create', { title: 'deploy', content })
      expect(denied.isError).toBe(true)
      expect(denied.text).toContain('第 1 行（sk- 开头的密钥）')
      expect(denied.text).not.toContain(sampleToken('sk').slice(3))

      const created = await callTool('kioku_create', {
        title: 'deploy',
        content: '示例：password = example',
        plaintext_ok: true,
      })
      expect(created.isError).toBe(false)
      expect(created.text).not.toContain('提醒')
      const shortId = created.text.match(/m-[2-9a-hjkmnp-tv-z]{6,8}/)![0]

      const updated = await callTool('kioku_update', {
        id: shortId,
        content: '示例：password = example\n另一个：token = sample',
      })
      expect(updated.isError).toBe(true)
      expect(updated.text).toContain('第 2 行')
      const allowed = await callTool('kioku_update', {
        id: shortId,
        content: '示例：password = example\n另一个：token = sample',
        plaintext_ok: true,
      })
      expect(allowed.isError).toBe(false)
      // 只有新增的这几处被确认了：正文里原来就有的照常提醒
      expect(allowed.text).toContain('提醒')
      // 已有的疑似明文：只改元数据照常写入，结果里提醒换成占位符
      const meta = await callTool('kioku_update', { id: shortId, priority: 1 })
      expect(meta.isError).toBe(false)
      expect(meta.text).toContain('提醒')
      // 原来的那几处都换掉了、只剩这次新增的：带 plaintext_ok 不再提醒
      const replaced = await callTool('kioku_update', {
        id: shortId,
        content: '示例：password = 见团队的密码库\ntoken = other',
        plaintext_ok: true,
      })
      expect(replaced.isError).toBe(false)
      expect(replaced.text).not.toContain('提醒')
    })
  })

  describe('管理界面的写入', () => {
    it('不带标记时同样拒绝，错误体带行号与类别，说明逐处处理', async () => {
      const err = await rejected(
        await viaConsole('POST', { title: 'wifi', content: '密码：hunter2' }),
      )
      expect(err.plaintext).toEqual([{ line: 1, kind: 'label' }])
      expect(err.error).toContain('转存')
      expect(err.error).not.toContain('plaintext_ok')
    })

    it('allowPlaintext：照样保存，进待处理；新建与修改都行', async () => {
      const wifi = await ok(
        await viaConsole('POST', {
          title: 'wifi',
          content: '密码：hunter2',
          allowPlaintext: true,
        }),
        201,
      )
      expect(await inbox()).toBe(1)
      await ok(
        await viaConsole('PATCH', {
          id: wifi.id,
          content: '密码：hunter2\ntoken = abc',
          allowPlaintext: true,
        }),
      )
      expect(await inbox()).toBe(1)
    })

    it('allowPlaintext：能改这条记忆的编辑者也能照样保存，进待处理由记忆圈所有者转存', async () => {
      const editor = await addMember(database.db, ws.circleId, 'bob', 'editor')
      const wifi = await ok(
        await viaConsole(
          'POST',
          { title: 'wifi', content: '密码：hunter2', allowPlaintext: true },
          editor.cookie,
          ws.circleId,
        ),
        201,
      )
      await ok(
        await viaConsole(
          'PATCH',
          { id: wifi.id, content: '密码：hunter2\ntoken = abc', allowPlaintext: true },
          editor.cookie,
          ws.circleId,
        ),
      )
      expect(await inbox(ws.circleId)).toBe(1)
      // 查看者写不了，带着标记也一样
      const viewer = await addMember(database.db, ws.circleId, 'carol', 'viewer')
      const res = await viaConsole(
        'POST',
        { title: 'other', content: '密码：hunter2', allowPlaintext: true },
        viewer.cookie,
        ws.circleId,
      )
      expect(res.status).toBe(403)
    })

    it('从机密强制降级只给记忆圈所有者：不是记忆圈所有者带着 allowPlaintext 也拒绝', async () => {
      const locked = await ok(
        await viaConsole('POST', {
          title: 'locked',
          content: '密码：hunter2',
          sensitivity: 'secret',
        }),
        201,
      )
      // 编辑者改不了机密，走不到这一步：服务层按 circleOwner 判断，这里换掉它直接测
      const circleAccess = (await consoleCircleFor(deps(), ws.accountId, ws.personalCircleId))!
      const notOwner = new EntryService({
        db: database.db,
        access: circleAccess.access,
        masterKey,
        actor: { accountId: ws.accountId },
        secretRead: 'explicit',
        circleOwner: false,
      })
      const owner = new EntryService({
        ...(notOwner as unknown as { ctx: EntryContext }).ctx,
        circleOwner: true,
      })
      await expect(
        notOwner.update({
          id: locked.id,
          sensitivity: 'private',
          allowPlaintext: true,
        }),
      ).rejects.toThrow('记忆圈所有者')
      await expect(
        owner.update({ id: locked.id, sensitivity: 'private', allowPlaintext: true }),
      ).resolves.toMatchObject({ sensitivity: 'private' })
    })

    it('ignorePlaintext：编辑者也能用，保存时记为已忽略，不进待处理，历史里有一条忽略', async () => {
      const editor = await addMember(database.db, ws.circleId, 'bob', 'editor')
      const created = await ok(
        await viaConsole(
          'POST',
          { title: 'demo', content: '示例：password = example', ignorePlaintext: true },
          editor.cookie,
          ws.circleId,
        ),
        201,
      )
      expect(created.plaintextIgnored).toBe(true)
      expect(await inbox(ws.circleId)).toBe(0)
      // 修改时再新增一处：再带 ignorePlaintext 照样记下新的正文
      const edited = await ok(
        await viaConsole(
          'PATCH',
          {
            id: created.id,
            content: '示例：password = example\ntoken = sample',
            ignorePlaintext: true,
          },
          editor.cookie,
          ws.circleId,
        ),
      )
      expect(edited.plaintextIgnored).toBe(true)
      expect(await inbox(ws.circleId)).toBe(0)
      const history = (await (
        await consoleGet(`/entries/history?id=${created.id}`, ws.circleId)
      ).json()) as EntryHistory
      expect(history.events.map((e) => e.type)).toEqual([
        'ignore_plaintext',
        'update',
        'ignore_plaintext',
        'create',
      ])
      // 不带标记、正文又改了：提示回来，新增的照样拦
      const err = await rejected(
        await viaConsole(
          'PATCH',
          { id: created.id, content: '示例：password = example\nsecret = other' },
          editor.cookie,
          ws.circleId,
        ),
      )
      expect(err.plaintext).toEqual([{ line: 2, kind: 'label' }])
    })

    it('ignorePlaintext 不放行从机密降级，降级照旧要 allowPlaintext', async () => {
      const locked = await ok(
        await viaConsole('POST', {
          title: 'locked',
          content: '密码：hunter2',
          sensitivity: 'secret',
        }),
        201,
      )
      const res = await viaConsole('PATCH', {
        id: locked.id,
        sensitivity: 'private',
        ignorePlaintext: true,
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('降级')
      await ok(
        await viaConsole('PATCH', {
          id: locked.id,
          sensitivity: 'private',
          allowPlaintext: true,
        }),
      )
    })

    it('plaintextOk 只给 Key：管理界面的请求里去掉，照样拦', async () => {
      const err = await rejected(
        await viaConsole('POST', {
          title: 'note-x',
          content: '密码：hunter2',
          plaintextOk: true,
        }),
      )
      expect(err.plaintext).toEqual([{ line: 1, kind: 'label' }])
      await ok(
        await viaConsole('POST', {
          title: 'note-y',
          content: '普通的说明',
          plaintextOk: true,
        }),
        201,
      )
    })

    it('ignorePlaintext：旧的疑似明文这次都删掉了的照常记忽略，不留在待处理', async () => {
      const m = await ok(
        await viaConsole('POST', {
          title: 'router',
          content: '路由器\n管理员密码：hunter2',
          allowPlaintext: true,
        }),
        201,
      )
      expect(await inbox()).toBe(1)
      const edited = await ok(
        await viaConsole('PATCH', {
          id: m.id,
          content: '路由器\n管理员密码：见团队的密码库\ntoken = example',
          ignorePlaintext: true,
        }),
      )
      expect(edited.plaintextIgnored).toBe(true)
      expect(await inbox()).toBe(0)
    })

    it('ignorePlaintext：写入之前已有没处理的疑似明文时只放行写入，不记忽略，改完仍在待处理', async () => {
      const m = await ok(
        await viaConsole('POST', {
          title: 'router',
          content: '路由器\n管理员密码：hunter2',
          allowPlaintext: true,
        }),
        201,
      )
      expect(await inbox()).toBe(1)
      // 改了别处，再新增一处，带着「不是凭据」：放行写入，旧的那处还没人处理
      const edited = await ok(
        await viaConsole('PATCH', {
          id: m.id,
          content: '路由器在客厅\n管理员密码：hunter2\ntoken = example',
          ignorePlaintext: true,
        }),
      )
      expect(edited.plaintextIgnored).toBe(false)
      expect(await inbox()).toBe(1)
      const history = (await (
        await consoleGet(`/entries/history?id=${m.id}`)
      ).json()) as EntryHistory
      expect(history.events.map((e) => e.type)).toEqual(['update', 'create'])
      // 之前已忽略的：照常记
      await ok(
        await app.request(
          `/v1/circles/${ws.personalCircleId}/entries/ignore-plaintext`,
          jsonRequest(
            'POST',
            { entryId: m.id, expectedVersion: edited.version },
            { cookie: ws.cookie },
          ),
        ),
      )
      expect(await inbox()).toBe(0)
      const again = await ok(
        await viaConsole('PATCH', {
          id: m.id,
          content: '路由器在客厅\n管理员密码：hunter2\ntoken = example\nsecret = sample',
          ignorePlaintext: true,
        }),
      )
      expect(again.plaintextIgnored).toBe(true)
      expect(await inbox()).toBe(0)
    })
  })
})
