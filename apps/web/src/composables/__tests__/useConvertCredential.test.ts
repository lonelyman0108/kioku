import type { ConsoleMemoryView, ConvertedToCredential } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, ref, type EffectScope } from 'vue'

import { ApiError } from '../../api/client'
import { useConvertCredential } from '../useConvertCredential'

// 接口换成假的，别的都是真的：vue 的响应式、vue-query 的缓存。对话框只管长相，能不能提交都在这里定
const fakes = vi.hoisted(() => ({
  api: {
    memory: vi.fn(),
    credentials: vi.fn(),
    convertToCredential: vi.fn(),
    matchCredentialValues: vi.fn(),
  },
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const URI = 'user://nas'
const memory = (over: Partial<ConsoleMemoryView> = {}): ConsoleMemoryView =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    uri: URI,
    title: 'NAS',
    layer: 'user',
    sensitivity: 'private',
    version: 1,
    content: '密码：hunter2-not-real，平时不用。',
    ...over,
  }) as ConsoleMemoryView

let client: QueryClient
let scope: EffectScope
const onConverted = vi.fn()

function start() {
  const vueApp = createApp({})
  vueApp.use(VueQueryPlugin, { queryClient: client })
  scope = effectScope()
  return vueApp.runWithContext(() =>
    scope.run(() => useConvertCredential(ref('s1'), ref(URI), onConverted))!,
  )
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve))
  }
}

// 读到这条记忆，显示并核对过值
async function ready(over: Partial<ConsoleMemoryView> = {}) {
  fakes.api.memory.mockResolvedValue(memory(over))
  const convert = start()
  await convert.load()
  await nextTick()
  return convert
}
async function shown(over: Partial<ConsoleMemoryView> = {}) {
  const convert = await ready(over)
  convert.shown.value = true
  await nextTick()
  return convert
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  fakes.api.memory.mockReset()
  fakes.api.credentials.mockReset().mockResolvedValue({ items: [], truncated: false })
  fakes.api.convertToCredential.mockReset()
  fakes.api.matchCredentialValues
    .mockReset()
    .mockImplementation(async (_sid: string, body: { values: string[] }) => ({
      items: body.values.map(() => ({ credentials: [], vaultItems: [] })),
      unavailableConnections: 0,
    }))
  onConverted.mockReset()
})
afterEach(() => {
  scope.stop()
  client.clear()
})

describe('读到记忆之后', () => {
  it('猜出值和字段名，建议标识和名称', async () => {
    const convert = await ready()
    expect(convert.form).toMatchObject({
      value: 'hunter2-not-real',
      field: 'password',
      identifier: 'nas',
      name: 'NAS',
    })
    expect(convert.blocked.value).toBe(false)
  })

  it('没显示过不能提交，显示之后才能；隐藏之后改过要再显示一次', async () => {
    const convert = await ready()
    expect(convert.canSubmit.value).toBe(false)
    expect(convert.problem.value).toBe('请先显示并核对值')
    convert.shown.value = true
    await nextTick()
    expect(convert.canSubmit.value).toBe(true)
    convert.shown.value = false
    convert.form.value = 'hunter2-not'
    await nextTick()
    expect(convert.canSubmit.value).toBe(false)
    convert.shown.value = true
    await nextTick()
    // 改过的值要等按值查找回来
    expect(convert.problem.value).toBe('正在查找同值的凭据')
    await new Promise((resolve) => setTimeout(resolve, 450))
    await settle()
    expect(convert.canSubmit.value).toBe(true)
  })

  it('遮盖时没有前后文', async () => {
    const convert = await ready()
    expect(convert.context.value).toBeNull()
    convert.shown.value = true
    await nextTick()
    expect(convert.context.value).toMatchObject({ before: '密码：', after: '，平时不用。' })
  })
})

describe('占位符放不进这条记忆', () => {
  it.each([
    ['通用', { layer: 'core', sensitivity: 'internal' }],
    ['本人但敏感级不够', { layer: 'user', sensitivity: 'internal' }],
    ['应用、私密', { layer: 'app', sensitivity: 'private' }],
  ] as const)('%s：值不拿出来，提交不了', async (_name, over) => {
    const convert = await ready(over)
    expect(convert.blocked.value).toBe(true)
    expect(convert.form.value).toBe('')
    expect(convert.candidates.value).toEqual([])
    convert.shown.value = true
    await nextTick()
    expect(convert.canSubmit.value).toBe(false)
    await convert.submit()
    expect(fakes.api.convertToCredential).not.toHaveBeenCalled()
  })

  it('列表读旧了才走到这里：顺带让列表重读，那一行也换成去调整', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await ready({ layer: 'core', sensitivity: 'internal' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memory-list', 's1'] })
  })

  it('本人、私密的不受影响', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    expect((await shown()).canSubmit.value).toBe(true)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('机密的正文读不到，同样提交不了', async () => {
    const convert = await ready({ sensitivity: 'secret', content: null })
    expect(convert.blocked.value).toBe(false)
    convert.shown.value = true
    await nextTick()
    expect(convert.canSubmit.value).toBe(false)
  })
})

describe('重新读取', () => {
  it('进行中不能提交：手里的是旧版本，表单藏着', async () => {
    const convert = await shown()
    expect(convert.canSubmit.value).toBe(true)
    const pending = deferred<ConsoleMemoryView>()
    fakes.api.memory.mockReturnValue(pending.promise)
    const loading = convert.load()
    await nextTick()
    expect(convert.loading.value).toBe(true)
    expect(convert.canSubmit.value).toBe(false)
    await convert.submit()
    expect(fakes.api.convertToCredential).not.toHaveBeenCalled()
    pending.resolve(memory({ version: 2 }))
    await loading
  })

  it('失败之后不能提交，能再试；再试成功后也要重新核对', async () => {
    const convert = await shown()
    fakes.api.memory.mockRejectedValue(new ApiError(500, '服务端的文字'))
    await convert.load()
    expect(convert.loadFailure.value).toBe('服务端的文字')
    expect(convert.canSubmit.value).toBe(false)
    await convert.submit()
    expect(fakes.api.convertToCredential).not.toHaveBeenCalled()

    fakes.api.memory.mockResolvedValue(memory({ version: 2 }))
    await convert.load()
    await nextTick()
    expect(convert.loadFailure.value).toBeNull()
    expect(convert.canSubmit.value).toBe(false)
    expect(convert.problem.value).toBe('请先显示并核对值')
    convert.shown.value = true
    await nextTick()
    expect(convert.canSubmit.value).toBe(true)
  })

  it('值还在正文里：值和字段名都留着，新猜的不算', async () => {
    const convert = await shown({ content: 'token: abcd1234\n密码: hunter22' })
    convert.form.value = 'hunter22'
    convert.form.field = 'mysql'
    convert.form.identifier = 'my-id'
    await nextTick()
    fakes.api.memory.mockResolvedValue(
      memory({ version: 2, content: 'token: abcd1234\n密码: hunter22' }),
    )
    await convert.load()
    await nextTick()
    expect(convert.form).toMatchObject({ value: 'hunter22', field: 'mysql', identifier: 'my-id' })
    expect(convert.canSubmit.value).toBe(false)
  })

  it('值没有了：字段名也不留，免得密码存成字段 token', async () => {
    const convert = await shown({ content: 'token: abcd1234\n密码: hunter22' })
    expect(convert.form).toMatchObject({ value: 'abcd1234', field: 'token' })
    convert.form.identifier = 'my-id'
    fakes.api.memory.mockResolvedValue(memory({ version: 2, content: '密码: hunter22' }))
    await convert.load()
    await nextTick()
    expect(convert.form).toMatchObject({
      value: 'hunter22',
      field: 'password',
      identifier: 'my-id',
    })
  })

  it('重读之后变成放不进了：不留值', async () => {
    const convert = await shown()
    fakes.api.memory.mockResolvedValue(memory({ version: 2, layer: 'core' }))
    await convert.load()
    await nextTick()
    expect(convert.blocked.value).toBe(true)
    expect(convert.form.value).toBe('')
    expect(convert.canSubmit.value).toBe(false)
  })

  it('关上之后晚到的结果不算', async () => {
    const convert = await shown()
    const pending = deferred<ConsoleMemoryView>()
    fakes.api.memory.mockReturnValue(pending.promise)
    const loading = convert.load()
    await nextTick()
    convert.reset()
    pending.resolve(memory({ version: 2 }))
    await loading
    expect(convert.memory.value).toBeNull()
    expect(convert.form.value).toBe('')
    expect(convert.loading.value).toBe(false)
  })
})

describe('提交', () => {
  const done = {
    memory: memory({ version: 2, content: '密码：{{cred:nas#password}}' }),
    credential: { id: 'c1', name: 'nas' },
    replaced: 1,
    scrubbedEvents: 1,
    plaintextVersions: 2,
    otherMemories: 1,
  } as unknown as ConvertedToCredential

  it('带着读到的版本和当前的值；成功后值不留，结果和遗留都有', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockResolvedValue(done)
    await convert.submit()
    expect(fakes.api.convertToCredential).toHaveBeenCalledWith('s1', {
      memoryId: memory().id,
      expectedVersion: 1,
      value: 'hunter2-not-real',
      target: { kind: 'hosted', identifier: 'nas', name: 'NAS', field: 'password' },
    })
    expect(convert.form.value).toBe('')
    expect(convert.result.value).toEqual(done)
    expect(convert.leftovers.value).toHaveLength(2)
    expect(onConverted).toHaveBeenCalledWith(done.memory, done)
  })

  it('错误按服务端的文字显示', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(400, '服务端的文字'))
    await convert.submit()
    expect(convert.failure.value).toBe('服务端的文字')
    expect(convert.result.value).toBeNull()
  })

  it('400 不给重新读取：重读解决不了，哪怕这时版本也变了', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(400, '放不进'))
    fakes.api.memory.mockClear().mockResolvedValue(memory({ version: 2 }))
    await convert.submit()
    expect(convert.canReload.value).toBe(false)
    expect(fakes.api.memory).not.toHaveBeenCalled()
  })

  it('版本变了给重新读取', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '版本已变化'))
    fakes.api.memory.mockResolvedValue(memory({ version: 2 }))
    await convert.submit()
    expect(convert.failure.value).toBe('版本已变化')
    expect(convert.canReload.value).toBe(true)
  })

  it('同样是 409 的标识冲突不给：版本没变，重读没有用', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '标识已被占用'))
    await convert.submit()
    expect(convert.failure.value).toBe('标识已被占用')
    expect(convert.canReload.value).toBe(false)
  })

  it('比版本时读取失败要留着入口：提示让人重新读取，再提交一直 409', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '版本已变化'))
    fakes.api.memory.mockRejectedValue(new ApiError(500, '读不到'))
    await convert.submit()
    await settle()
    expect(convert.canReload.value).toBe(true)
    expect(convert.submitting.value).toBe(false)
  })

  it('比版本时发现换成了同版本的另一条：给', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '版本已变化'))
    fakes.api.memory.mockResolvedValue(memory({ id: '00000000-0000-4000-8000-000000000002' }))
    await convert.submit()
    expect(convert.canReload.value).toBe(true)
  })
})

// 切空间时对话框被重置，这时提交可能还没回来；重置之后可能已经打开了另一条记忆
describe('提交没回来就被重置', () => {
  const done = () =>
    ({
      memory: memory({ version: 2 }),
      credential: { id: 'c1' },
      memories: [],
      plaintextVersions: 0,
      plaintextElsewhere: 0,
    }) as unknown as ConvertedToCredential

  async function pending() {
    const convert = await shown()
    const response = deferred<ConvertedToCredential>()
    fakes.api.convertToCredential.mockReturnValue(response.promise)
    const submitted = convert.submit()
    await nextTick()
    expect(convert.submitting.value).toBe(true)
    return { convert, response, submitted }
  }

  it('重置之后 submitting 立刻放开，不卡着新对话框', async () => {
    const { convert, response, submitted } = await pending()
    convert.reset()
    expect(convert.submitting.value).toBe(false)
    response.resolve(done())
    await submitted
    expect(convert.submitting.value).toBe(false)
  })

  it('迟到的成功不写状态、不触发回调，缓存照样刷新：服务端已经写了', async () => {
    const { convert, response, submitted } = await pending()
    convert.reset()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    response.resolve(done())
    await submitted
    expect(convert.result.value).toBeNull()
    expect(onConverted).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memory-list', 's1'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['credentials', 's1'] })
  })

  it('新打开的另一条记忆不受迟到的响应影响', async () => {
    const { convert, response, submitted } = await pending()
    convert.reset()
    fakes.api.memory.mockResolvedValue(memory({ content: '密码：another-value-1，别的记忆。' }))
    await convert.load()
    await nextTick()
    expect(convert.form.value).toBe('another-value-1')
    response.resolve(done())
    await submitted
    expect(convert.form.value).toBe('another-value-1')
    expect(convert.result.value).toBeNull()
    expect(onConverted).not.toHaveBeenCalled()
  })

  it('迟到的失败不写错误，也不去重读', async () => {
    const { convert, response, submitted } = await pending()
    convert.reset()
    fakes.api.memory.mockClear()
    response.reject(new ApiError(409, '版本已变化'))
    await submitted
    expect(convert.failure.value).toBeNull()
    expect(convert.canReload.value).toBe(false)
    expect(fakes.api.memory).not.toHaveBeenCalled()
  })

  it('比版本的途中被重置：结果丢掉', async () => {
    const { convert, response, submitted } = await pending()
    const reread = deferred<ConsoleMemoryView>()
    fakes.api.memory.mockClear().mockReturnValue(reread.promise)
    response.reject(new ApiError(409, '版本已变化'))
    await settle()
    expect(fakes.api.memory).toHaveBeenCalled()
    expect(convert.failure.value).toBe('版本已变化')
    convert.reset()
    reread.resolve(memory({ version: 9 }))
    await submitted
    expect(convert.canReload.value).toBe(false)
  })

  it('旧的提交回来时不放开新提交的 submitting，也不写它的错误', async () => {
    const { convert, response, submitted } = await pending()
    convert.reset()
    fakes.api.memory.mockResolvedValue(memory())
    await convert.load()
    convert.shown.value = true
    // 等按值查找回来才能提交
    await settle()
    fakes.api.convertToCredential.mockReturnValue(new Promise(() => {}))
    void convert.submit()
    await nextTick()
    expect(convert.submitting.value).toBe(true)
    response.reject(new ApiError(500, '旧的'))
    await submitted
    expect(convert.submitting.value).toBe(true)
    expect(convert.failure.value).toBeNull()
  })
})

describe('转存的去处', () => {
  const credential = {
    id: '00000000-0000-4000-8000-0000000000c1',
    identifier: 'nas-admin',
    name: 'NAS 管理',
    field: 'password',
  }
  const item = {
    connectionId: '00000000-0000-4000-8000-0000000000a1',
    itemId: 'item-1',
    itemName: 'NAS',
    itemField: 'login.password',
    credential: null,
  }
  const matchWith = (match: { credentials: unknown[]; vaultItems: unknown[] }) =>
    fakes.api.matchCredentialValues.mockImplementation(
      async (_sid: string, body: { values: string[] }) => ({
        items: body.values.map(() => match),
        unavailableConnections: 1,
      }),
    )

  it('打开时按值查找，只发合规的值；结果不进查询的缓存', async () => {
    const convert = await shown({ content: '密码：hunter2-not-real\ntoken=abc' })
    await settle()
    expect(fakes.api.matchCredentialValues).toHaveBeenCalledWith('s1', {
      values: ['hunter2-not-real'],
    })
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey[0]),
    ).not.toContain('credential-match')
    expect(convert.unavailableConnections.value).toBe(0)
  })

  it('默认选第一个对上的：已有凭据排在条目前面，发 credential', async () => {
    matchWith({ credentials: [credential], vaultItems: [item] })
    const convert = await shown()
    await settle()
    expect(convert.choices.value.destinations.map((d) => d.kind)).toEqual([
      'credential',
      'vault',
      'hosted',
    ])
    expect(convert.selected.value.kind).toBe('credential')
    expect(convert.placeholder.value).toBe('{{cred:nas-admin#password}}')
    expect(convert.unavailableConnections.value).toBe(1)
    fakes.api.convertToCredential.mockResolvedValue({ memory: memory({ version: 2 }) })
    await convert.submit()
    expect(fakes.api.convertToCredential.mock.calls[0]![1].target).toEqual({
      kind: 'credential',
      credentialId: credential.id,
      field: 'password',
    })
  })

  it('选尚未起标识的条目：在这里起标识，建议按条目名称，发 vault', async () => {
    matchWith({ credentials: [], vaultItems: [item] })
    fakes.api.credentials.mockResolvedValue({ items: [{ identifier: 'nas' }], truncated: false })
    const convert = await shown()
    await settle()
    expect(convert.selected.value.kind).toBe('vault')
    const key = convert.itemKey(item)
    expect(convert.vaultIdentifiers[key]).toBe('nas-2')
    convert.vaultIdentifiers[key] = 'nas-box'
    await nextTick()
    expect(convert.placeholder.value).toBe('{{cred:nas-box#password}}')
    fakes.api.convertToCredential.mockResolvedValue({ memory: memory({ version: 2 }) })
    await convert.submit()
    expect(fakes.api.convertToCredential.mock.calls[0]![1].target).toEqual({
      kind: 'vault',
      connectionId: item.connectionId,
      itemId: 'item-1',
      itemField: 'login.password',
      identifier: 'nas-box',
    })
  })

  it('手动选过的去处不随匹配结果换；选新建托管凭据发 hosted', async () => {
    matchWith({ credentials: [credential], vaultItems: [] })
    const convert = await shown()
    await settle()
    convert.choose('hosted')
    await nextTick()
    expect(convert.selected.value.kind).toBe('hosted')
    fakes.api.convertToCredential.mockResolvedValue({ memory: memory({ version: 2 }) })
    await convert.submit()
    expect(fakes.api.convertToCredential.mock.calls[0]![1].target.kind).toBe('hosted')
  })

  it('起了标识却没对应这个字段的条目只列出来，不能选', async () => {
    matchWith({
      credentials: [],
      vaultItems: [{ ...item, credential: { id: credential.id, identifier: 'nas' } }],
    })
    const convert = await shown()
    await settle()
    expect(convert.choices.value.destinations.map((d) => d.kind)).toEqual(['hosted'])
    expect(convert.choices.value.unmapped).toEqual([
      { itemName: 'NAS', itemField: 'login.password', identifier: 'nas' },
    ])
  })

  it('还在查时不能提交：默认的去处可能还会变', async () => {
    const pending = deferred<unknown>()
    fakes.api.matchCredentialValues.mockReturnValue(pending.promise)
    const convert = await shown()
    expect(convert.problem.value).toBe('正在查找同值的凭据')
    expect(convert.canSubmit.value).toBe(false)
    pending.resolve({ items: [{ credentials: [], vaultItems: [] }], unavailableConnections: 0 })
    await settle()
    expect(convert.canSubmit.value).toBe(true)
  })

  it('查不了时照样能新建托管凭据，说明查找失败', async () => {
    fakes.api.matchCredentialValues.mockRejectedValue(new ApiError(502, '密码库无法连接'))
    const convert = await shown()
    await settle()
    expect(convert.matchFailure.value).toBe('密码库无法连接')
    expect(convert.selected.value.kind).toBe('hosted')
    expect(convert.canSubmit.value).toBe(true)
  })

  it('值改了之后停一会儿再查新的值', async () => {
    vi.useFakeTimers()
    try {
      const convert = await shown()
      await vi.runAllTimersAsync()
      fakes.api.matchCredentialValues.mockClear()
      convert.form.value = 'hunter2-not'
      await nextTick()
      expect(fakes.api.matchCredentialValues).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      expect(fakes.api.matchCredentialValues).toHaveBeenCalledWith('s1', {
        values: ['hunter2-not'],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('服务端核对值不一致（400）或条目已有凭据（409）照现有的错误提示显示', async () => {
    matchWith({ credentials: [], vaultItems: [item] })
    const convert = await shown()
    await settle()
    fakes.api.convertToCredential.mockRejectedValue(
      new ApiError(400, '条目字段的值与要转存的值不一致'),
    )
    await convert.submit()
    expect(convert.failure.value).toBe('条目字段的值与要转存的值不一致')
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '这个条目已有凭据'))
    await convert.submit()
    await settle()
    expect(convert.failure.value).toBe('这个条目已有凭据')
    expect(convert.canReload.value).toBe(false)
  })

  it('重新读取时进行中的查找作废：恢复回来的手输值重新查一次，不会一直等着', async () => {
    const convert = await shown({ content: '密码：hunter2-not-real-x' })
    await settle()
    // 手输一个新值，查找发出去还没回来
    const stale = deferred<unknown>()
    fakes.api.matchCredentialValues.mockReturnValueOnce(stale.promise)
    convert.form.value = 'hunter2-not-real'
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(convert.matchingValue.value).toBe(true)
    // 重新读取：值还在正文里，留下
    fakes.api.memory.mockResolvedValue(memory({ version: 2, content: '密码：hunter2-not-real-x' }))
    await convert.load()
    await settle()
    expect(convert.form.value).toBe('hunter2-not-real')
    stale.resolve({ items: [{ credentials: [], vaultItems: [] }], unavailableConnections: 0 })
    await settle()
    expect(convert.matchingValue.value).toBe(false)
    expect(fakes.api.matchCredentialValues).toHaveBeenLastCalledWith('s1', {
      values: ['hunter2-not-real'],
    })
  })
})
