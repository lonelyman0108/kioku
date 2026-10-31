import type { BackupSettingsView } from '@kioku/contracts'
import { QueryClient, useQuery } from '@tanstack/vue-query'
import { describe, expect, it } from 'vitest'
import { computed, effectScope, nextTick, ref } from 'vue'

import { useBackupForm } from '../useBackupForm'

const view = (changes: Partial<BackupSettingsView> = {}): BackupSettingsView => ({
  configured: true,
  endpoint: 'https://s3.example.com',
  region: 'eu-west-1',
  bucket: 'kioku-backup',
  prefix: 'kioku',
  accessKeyId: 'AKIAEXAMPLE',
  hasSecret: true,
  hour: 19,
  keep: 7,
  status: { lastSuccess: null, lastError: null },
  ...changes,
})

const queryKey = ['settings', 'backup']

describe('备份设置的表单', () => {
  const start = (initial?: BackupSettingsView) => {
    const client = new QueryClient()
    if (initial) client.setQueryData(queryKey, initial)
    const current = ref<BackupSettingsView | undefined>(initial)
    // 和真的查询一样：缓存先变，view 晚一拍才跟上
    const arrive = (next: BackupSettingsView) => {
      client.setQueryData(queryKey, next)
      current.value = next
    }
    const scope = effectScope()
    const backup = scope.run(() => useBackupForm(current, client, queryKey))!
    return { arrive, ...backup }
  }

  it('还没读到时不算有改动', () => {
    expect(start().dirty.value).toBe(false)
  })

  it('第一次读到就填进表单，不算有改动', async () => {
    const { arrive, form, dirty } = start()
    arrive(view())
    await nextTick()
    expect(form).toMatchObject({ endpoint: 'https://s3.example.com', bucket: 'kioku-backup' })
    expect(dirty.value).toBe(false)
  })

  it('没配置过时填默认值，也不算有改动', () => {
    const { form, dirty } = start(
      view({
        configured: false,
        endpoint: null,
        region: null,
        bucket: null,
        prefix: null,
        accessKeyId: null,
        hasSecret: false,
        hour: null,
        keep: null,
      }),
    )
    expect(form).toMatchObject({ endpoint: '', region: 'us-east-1', keep: 7 })
    expect(typeof form.hour).toBe('number')
    expect(dirty.value).toBe(false)
  })

  it.each([
    ['endpoint', 'https://other.example.com'],
    ['region', 'us-east-1'],
    ['bucket', 'other-bucket'],
    ['prefix', ''],
    ['accessKeyId', 'AKIAOTHER'],
    ['secretAccessKey', 'new-secret'],
    ['hour', 3],
    ['keep', 30],
  ] as const)('改了 %s 算有改动，改回去就没有了', async (field, value) => {
    const { form, dirty } = start(view())
    const before = form[field]
    Object.assign(form, { [field]: value })
    expect(dirty.value).toBe(true)
    Object.assign(form, { [field]: before })
    expect(dirty.value).toBe(false)
  })

  it('别的管理员保存过、这里什么都没改：跟上新的设置，不算有改动', async () => {
    const { arrive, form, dirty } = start(view())
    arrive(view({ bucket: 'changed-by-other', keep: 30 }))
    await nextTick()
    expect(form.bucket).toBe('changed-by-other')
    expect(form.keep).toBe(30)
    expect(dirty.value).toBe(false)
  })

  it('正在填的内容不被刷新冲掉，别人改的字段也不混进来', async () => {
    const { arrive, form, dirty } = start(view())
    form.prefix = 'typing'
    await nextTick()
    arrive(view({ bucket: 'changed-by-other' }))
    await nextTick()
    expect(form.prefix).toBe('typing')
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(true)
  })

  it('填了 Secret 也算正在填：刷新不冲掉', async () => {
    const { arrive, form, dirty } = start(view())
    form.secretAccessKey = 'new-secret'
    await nextTick()
    arrive(view({ bucket: 'changed-by-other' }))
    await nextTick()
    expect(form.secretAccessKey).toBe('new-secret')
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(true)
  })

  it('改动撤销之后跟上这段时间别人保存的设置', async () => {
    const { arrive, form, dirty } = start(view())
    form.prefix = 'typing'
    await nextTick()
    arrive(view({ bucket: 'changed-by-other' }))
    await nextTick()
    form.prefix = 'kioku'
    await nextTick()
    expect(form.bucket).toBe('changed-by-other')
    expect(dirty.value).toBe(false)
  })

  it('只是备份的状态变了：表单不动，不算有改动', async () => {
    const { arrive, form, dirty } = start(view())
    arrive(
      view({
        status: {
          lastSuccess: { at: '2026-11-01T00:00:00.000Z', bytes: 1, object: 'x' },
          lastError: null,
        },
      }),
    )
    await nextTick()
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(false)
  })

  it('自己保存之后按返回的设置同步，正在填的内容不算改动了', async () => {
    const { form, dirty, commit } = start(view())
    form.bucket = 'mine'
    await nextTick()
    await commit(view({ bucket: 'mine' }))
    expect(form.bucket).toBe('mine')
    expect(dirty.value).toBe(false)
    // view 这时还没跟上：改动状态一变，这里不能先填回旧的设置
    await nextTick()
    expect(form.bucket).toBe('mine')
    expect(dirty.value).toBe(false)
  })
})

describe('保存时还在路上的读取', () => {
  // 和页面一样接上真的查询；每次读取都等用例放行，放行时给的是服务端当时读到的内容
  const connect = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const pending: ((value: BackupSettingsView) => void)[] = []
    const scope = effectScope()
    const backup = scope.run(() => {
      const settings = useQuery(
        {
          queryKey,
          queryFn: () => new Promise<BackupSettingsView>((resolve) => pending.push(resolve)),
        },
        client,
      )
      const current = computed(() => settings.data.value)
      return useBackupForm(current, client, queryKey)
    })!
    const settled = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await nextTick()
    }
    await settled()
    pending.shift()!(view())
    await settled()
    return { client, pending, settled, ...backup }
  }

  it('保存之前发出、保存之后才回来：不能盖掉缓存，表单不能退回保存前的值', async () => {
    const { client, pending, settled, form, dirty, commit } = await connect()
    expect(form.bucket).toBe('kioku-backup')
    // 切回窗口或备份结束触发的刷新，还没回来时点了保存
    void client.refetchQueries({ queryKey, exact: true })
    await settled()
    form.bucket = 'mine'
    await commit(view({ bucket: 'mine' }))
    await settled()
    pending.shift()!(view())
    await settled()
    expect(client.getQueryData<BackupSettingsView>(queryKey)?.bucket).toBe('mine')
    expect(form.bucket).toBe('mine')
    expect(dirty.value).toBe(false)
  })

  it('保存之后发出的读取照常生效：别的管理员之后的改动还能跟上', async () => {
    const { client, pending, settled, form, commit } = await connect()
    await commit(view({ bucket: 'mine' }))
    void client.refetchQueries({ queryKey, exact: true })
    await settled()
    pending.shift()!(view({ bucket: 'changed-by-other' }))
    await settled()
    expect(form.bucket).toBe('changed-by-other')
  })

  it('只取消设置本身的读取：存储桶列表和立即备份的查询不受影响', async () => {
    const { client, settled, commit } = await connect()
    const objectsKey = [...queryKey, 'objects']
    void client.fetchQuery({ queryKey: objectsKey, queryFn: () => new Promise(() => {}) })
    await settled()
    await commit(view({ bucket: 'mine' }))
    expect(client.getQueryState(objectsKey)?.fetchStatus).toBe('fetching')
  })
})
