import type { ConsoleMemoryView, ConvertedToCredential } from '@kioku/contracts'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, effectScope, nextTick, ref, type EffectScope } from 'vue'

import { ApiError } from '../../api/client'
import { useConvertCredential } from '../useConvertCredential'

// 接口换成假的，别的都是真的：vue 的响应式、vue-query 的缓存。对话框只管长相，能不能提交都在这里定
const fakes = vi.hoisted(() => ({
  api: { memory: vi.fn(), credentials: vi.fn(), convertToCredential: vi.fn() },
}))
vi.mock('../../api/endpoints', () => ({ api: fakes.api }))

const URI = 'infra://nas'
const memory = (over: Partial<ConsoleMemoryView> = {}): ConsoleMemoryView =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    uri: URI,
    layer: 'private',
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
      name: 'nas',
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
    ['基础层', { layer: 'base', sensitivity: 'internal' }],
    ['私人层但敏感级不够', { layer: 'private', sensitivity: 'internal' }],
    ['应用层、私密', { layer: 'app', sensitivity: 'private' }],
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
    await ready({ layer: 'base', sensitivity: 'internal' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memory-list', 's1'] })
  })

  it('私人层、私密的不受影响', async () => {
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
    fakes.api.memory.mockResolvedValue(memory({ version: 2, layer: 'base' }))
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
      identifier: 'nas',
      name: 'nas',
      field: 'password',
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

  it('比版本时读取失败也不给', async () => {
    const convert = await shown()
    fakes.api.convertToCredential.mockRejectedValue(new ApiError(409, '版本已变化'))
    fakes.api.memory.mockRejectedValue(new ApiError(500, '读不到'))
    await convert.submit()
    await settle()
    expect(convert.canReload.value).toBe(false)
    expect(convert.submitting.value).toBe(false)
  })
})
