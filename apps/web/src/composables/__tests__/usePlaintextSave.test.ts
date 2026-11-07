import type { ConsoleCredential } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, ref, type EffectScope } from 'vue'

import { ApiError } from '../../api/client'
import { itemKey } from '../../plaintext'
import { addedSpots } from '../../plaintextSave'
import {
  usePlaintextSave,
  type PlaintextSaveRequest,
  type PlaintextSaveResult,
} from '../usePlaintextSave'

// 接口换成假的，别的都是真的：保存前逐处处理的规则都在这里定，对话框只管长相
const fakes = vi.hoisted(() => ({
  api: { credentials: vi.fn(), matchCredentialValues: vi.fn(), createCredential: vi.fn() },
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const CONTENT = '密码：hunter22\ntoken=abcd1234\n备用 hunter22，{{cred:hunter22#password}}'
const credential = {
  id: '00000000-0000-4000-8000-0000000000c1',
  identifier: 'router',
  name: '路由器',
  field: 'password',
}
const item = {
  connectionId: '00000000-0000-4000-8000-0000000000a1',
  itemId: 'item-1',
  itemName: 'NAS',
  itemField: 'login.password',
  credential: null,
}
const NONE = { credentials: [], vaultItems: [] }

let client: QueryClient
let scope: EffectScope
const proceeded = vi.fn<(result: PlaintextSaveResult) => void>()

function requestOf(over: Partial<PlaintextSaveRequest> = {}): PlaintextSaveRequest {
  const content = over.content ?? CONTENT
  return {
    content,
    uri: 'user://infra/nas',
    title: '家里的 NAS',
    layer: 'user',
    sensitivity: 'private',
    spots: addedSpots(null, content),
    rejected: false,
    ...over,
  }
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
  }
}

async function start(
  over: Partial<PlaintextSaveRequest> = {},
  canConvert = true,
  canSaveAnyway = true,
) {
  const vueApp = createApp({})
  vueApp.use(VueQueryPlugin, { queryClient: client })
  scope = effectScope()
  const request = ref<PlaintextSaveRequest | null>(requestOf(over))
  const save = vueApp.runWithContext(() =>
    scope.run(() =>
      usePlaintextSave(ref('s1'), request, ref(canConvert), ref(canSaveAnyway), proceeded),
    )!,
  )
  await settle()
  return { save, request }
}

// 按值给匹配结果：hunter22 对上已有凭据，别的看 others
function matchBy(others: Record<string, unknown> = {}) {
  fakes.api.matchCredentialValues.mockImplementation(
    async (_sid: string, body: { values: string[] }) => ({
      items: body.values.map((v) =>
        v === 'hunter22' ? { credentials: [credential], vaultItems: [] } : (others[v] ?? NONE),
      ),
      unavailableConnections: 0,
    }),
  )
}

const created = (over: Partial<ConsoleCredential>) =>
  ({ id: 'x', identifier: 'x', name: 'x', fields: [], ...over }) as unknown as ConsoleCredential

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fakes.api.credentials.mockReset().mockResolvedValue({
    items: [{ identifier: 'infra-nas' }],
    truncated: false,
  })
  fakes.api.createCredential.mockReset()
  matchBy()
  proceeded.mockReset()
})
afterEach(() => {
  scope.stop()
  client.clear()
})

describe('打开时', () => {
  it('每个值一处；按值查找同值的凭据，对上已有凭据的默认转存成它，别的要逐处选', async () => {
    const { save } = await start()
    expect(save.rows.value.map((r) => [r.spot.value, r.spot.lines, r.choice])).toEqual([
      ['hunter22', [1], 'convert'],
      ['abcd1234', [2], null],
    ])
    expect(fakes.api.matchCredentialValues).toHaveBeenCalledWith('s1', {
      values: ['hunter22', 'abcd1234'],
    })
    expect(save.problem.value).toBe('请选择转存为凭据或不是凭据')
    expect(save.ready.value).toBe(false)
  })

  it('新建托管凭据的标识按坐标建议，避开已有的与这次别处建议过的', async () => {
    const { save } = await start()
    expect(save.rows.value.map((r) => r.hosted.identifier)).toEqual([
      'infra-nas-password',
      'infra-nas-token',
    ])
    expect(save.rows.value[0]!.hosted.name).toBe('家里的 NAS')
  })

  it('不能管理凭据的成员不能转存、不查同值的凭据；能改这条记忆就能照样保存', async () => {
    const { save } = await start({}, false)
    expect(fakes.api.matchCredentialValues).not.toHaveBeenCalled()
    save.saveAnyway()
    expect(proceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CONTENT,
        content: CONTENT,
        flags: { allowPlaintext: true },
      }),
    )
  })

  it('不能照样保存时只能逐处选不是凭据', async () => {
    const { save } = await start({}, false, false)
    expect(fakes.api.matchCredentialValues).not.toHaveBeenCalled()
    for (const row of save.rows.value) {
      expect(save.convertBlocker(row)).toBe('仅空间所有者可转存为凭据')
      expect(row.choice).toBeNull()
    }
    save.rows.value.forEach((r) => (r.choice = 'ignore'))
    await nextTick()
    expect(save.ready.value).toBe(true)
    save.saveAnyway()
    expect(proceeded).not.toHaveBeenCalled()
    await save.proceed()
    expect(proceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CONTENT,
        content: CONTENT,
        flags: { ignorePlaintext: true },
      }),
    )
  })

  it('占位符放不进保存之后的记忆时不能转存，也不查', async () => {
    const { save } = await start({ layer: 'core', sensitivity: 'internal' })
    expect(fakes.api.matchCredentialValues).not.toHaveBeenCalled()
    expect(save.convertBlocker(save.rows.value[0]!)).toContain('凭据占位符只能放在本人')
  })

  it('太短的值不能转存，也不拿去查', async () => {
    const { save } = await start({ content: '密码：abc\n密码：hunter22' })
    expect(fakes.api.matchCredentialValues).toHaveBeenCalledWith('s1', { values: ['hunter22'] })
    expect(save.convertBlocker(save.rows.value[0]!)).toContain('至少 4 个字符')
  })
})

describe('保存', () => {
  it('全部转存：先建好凭据，再换掉正文里的值（占位符里的不换），不带标记', async () => {
    fakes.api.createCredential.mockImplementation(async (_sid, body) =>
      created({ identifier: body.identifier }),
    )
    const { save } = await start()
    const token = save.rows.value[1]!
    token.choice = 'convert'
    await nextTick()
    expect(save.placeholderFor(token)).toBe('{{cred:infra-nas-token#token}}')
    await save.proceed()
    expect(fakes.api.createCredential).toHaveBeenCalledTimes(1)
    expect(fakes.api.createCredential).toHaveBeenCalledWith('s1', {
      identifier: 'infra-nas-token',
      name: '家里的 NAS',
      source: { kind: 'hosted', values: { token: 'abcd1234' } },
    })
    expect(proceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CONTENT,
        content:
          '密码：{{cred:router#password}}\ntoken={{cred:infra-nas-token#token}}\n备用 {{cred:router#password}}，{{cred:hunter22#password}}',
        flags: {},
      }),
    )
  })

  it('有不是凭据的：转存的照样换，带 ignorePlaintext', async () => {
    const { save } = await start()
    save.rows.value[1]!.choice = 'ignore'
    await save.proceed()
    expect(fakes.api.createCredential).not.toHaveBeenCalled()
    const result = proceeded.mock.calls[0]![0]
    expect(result.flags).toEqual({ ignorePlaintext: true })
    expect(result.ignored).toEqual(['abcd1234'])
    expect(result.replacements).toEqual([
      { value: 'hunter22', placeholder: '{{cred:router#password}}' },
    ])
    expect(result.content).toContain('token=abcd1234')
    expect(result.content).not.toContain('密码：hunter22')
  })

  it('照样保存：正文原样，带 allowPlaintext', async () => {
    const { save } = await start()
    save.saveAnyway()
    expect(proceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CONTENT,
        content: CONTENT,
        flags: { allowPlaintext: true },
      }),
    )
  })

  it('尚未起标识的条目：在这里起标识（字段按条目推出），用建好的字段名', async () => {
    matchBy({ abcd1234: { credentials: [], vaultItems: [item] } })
    fakes.api.createCredential.mockResolvedValue(
      created({
        identifier: 'nas',
        fields: [
          { name: 'username', itemField: 'login.username' },
          { name: 'password', itemField: 'login.password' },
        ],
      }),
    )
    const { save } = await start()
    const token = save.rows.value[1]!
    token.choice = 'convert'
    await nextTick()
    expect(save.selectedOf(token).kind).toBe('vault')
    expect(save.vaultIdentifiers[itemKey(item)]).toBe('nas')
    expect(save.placeholderFor(token)).toBe('{{cred:nas#password}}')
    await save.proceed()
    expect(fakes.api.createCredential).toHaveBeenCalledWith('s1', {
      identifier: 'nas',
      name: 'NAS',
      source: { kind: 'vault', connectionId: item.connectionId, itemId: 'item-1' },
    })
    expect(proceeded.mock.calls[0]![0].content).toContain('token={{cred:nas#password}}')
  })

  it('中途失败：建好的留着，再点不重建；错误照服务端的文字', async () => {
    const { save } = await start({ content: 'token=abcd1234\n密码：qwerty99' })
    save.rows.value.forEach((r) => (r.choice = 'convert'))
    fakes.api.createCredential
      .mockResolvedValueOnce(created({ identifier: 'infra-nas-token' }))
      .mockRejectedValueOnce(new ApiError(409, '标识已被占用或不可用'))
    await save.proceed()
    expect(save.failure.value).toBe('标识已被占用或不可用')
    expect(proceeded).not.toHaveBeenCalled()
    expect(save.rows.value[0]!.created).toBe(true)
    save.rows.value[1]!.hosted.identifier = 'other'
    fakes.api.createCredential.mockResolvedValueOnce(created({ identifier: 'other' }))
    await save.proceed()
    expect(fakes.api.createCredential).toHaveBeenCalledTimes(3)
    expect(proceeded.mock.calls[0]![0].content).toBe(
      'token={{cred:infra-nas-token#token}}\n密码：{{cred:other#password}}',
    )
  })

  it('标识和已有的重复、这次两处重复、含要转存的值时不能保存', async () => {
    const { save } = await start({ content: 'token=abcd1234\n密码：qwerty99' })
    const [a, b] = save.rows.value
    a!.choice = 'convert'
    b!.choice = 'convert'
    a!.hosted.identifier = 'infra-nas'
    await nextTick()
    expect(save.problem.value).toBe('标识已被占用')
    a!.hosted.identifier = 'same'
    b!.hosted.identifier = 'same'
    await nextTick()
    expect(save.problem.value).toBe('标识重复')
    b!.hosted.identifier = 'qwerty99-box'
    await nextTick()
    expect(save.problem.value).toBe('标识、名称与字段名不能包含要转存的值')
  })

  it('换了一次保存：晚到的匹配结果不算', async () => {
    let resolve!: (value: unknown) => void
    fakes.api.matchCredentialValues.mockReturnValue(new Promise((r) => (resolve = r)))
    const { save, request } = await start()
    expect(save.matching.value).toBe(true)
    request.value = requestOf({ content: '密码：other-pass' })
    await settle()
    resolve({ items: [{ credentials: [credential], vaultItems: [] }], unavailableConnections: 0 })
    await settle()
    expect(save.rows.value.map((r) => r.spot.value)).toEqual(['other-pass'])
  })
})

describe('给条目起标识', () => {
  const longName = `${'名'.repeat(99)}😀尾`

  it('名称取条目名称，截到 100 个码元时不切开代理对', async () => {
    matchBy({ abcd1234: { credentials: [], vaultItems: [{ ...item, itemName: longName }] } })
    fakes.api.createCredential.mockResolvedValue(
      created({ identifier: 'x', fields: [{ name: 'password', itemField: 'login.password' }] }),
    )
    const { save } = await start()
    const token = save.rows.value[1]!
    token.choice = 'convert'
    save.vaultIdentifiers[itemKey(item)] = 'nas'
    await save.proceed()
    const name = fakes.api.createCredential.mock.calls[0]![1].name as string
    expect(name).toBe('名'.repeat(99))
    expect(name).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('条目名称里有要转存的值时不能保存：名称和标识一样是明文', async () => {
    matchBy({
      abcd1234: { credentials: [], vaultItems: [{ ...item, itemName: '路由器 abcd1234' }] },
    })
    const { save } = await start()
    const token = save.rows.value[1]!
    token.choice = 'convert'
    save.vaultIdentifiers[itemKey(item)] = 'router'
    await nextTick()
    expect(save.rowProblem(token)).toBe('标识、名称与字段名不能包含要转存的值')
  })
})

describe('再开一次的弹窗', () => {
  it('上一次标过不是凭据的带过来：不再列出，保存时照旧带 ignorePlaintext 并交回', async () => {
    const { save } = await start({
      content: '密码：qwerty99',
      ignored: ['abcd1234'],
    })
    save.rows.value[0]!.choice = 'convert'
    await save.proceed()
    expect(proceeded.mock.calls[0]![0]).toMatchObject({
      content: '密码：{{cred:infra-nas-password#password}}',
      flags: { ignorePlaintext: true },
      ignored: ['abcd1234'],
    })
  })

  it('一个值都不用查（都通不过转存的规则）时不发请求', async () => {
    await start({ content: '密码：abc' })
    expect(fakes.api.matchCredentialValues).not.toHaveBeenCalled()
  })
})
