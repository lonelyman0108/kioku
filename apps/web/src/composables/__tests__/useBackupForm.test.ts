import type { BackupSettingsView } from '@kioku/contracts'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'

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

describe('备份设置的表单', () => {
  const start = (initial?: BackupSettingsView) => {
    const current = ref<BackupSettingsView | undefined>(initial)
    const scope = effectScope()
    const backup = scope.run(() => useBackupForm(current))!
    return { current, ...backup }
  }

  it('还没读到时不算有改动', () => {
    expect(start().dirty.value).toBe(false)
  })

  it('第一次读到就填进表单，不算有改动', async () => {
    const { current, form, dirty } = start()
    current.value = view()
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
    const { current, form, dirty } = start(view())
    current.value = view({ bucket: 'changed-by-other', keep: 30 })
    await nextTick()
    expect(form.bucket).toBe('changed-by-other')
    expect(form.keep).toBe(30)
    expect(dirty.value).toBe(false)
  })

  it('正在填的内容不被刷新冲掉，别人改的字段也不混进来', async () => {
    const { current, form, dirty } = start(view())
    form.prefix = 'typing'
    await nextTick()
    current.value = view({ bucket: 'changed-by-other' })
    await nextTick()
    expect(form.prefix).toBe('typing')
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(true)
  })

  it('填了 Secret 也算正在填：刷新不冲掉', async () => {
    const { current, form, dirty } = start(view())
    form.secretAccessKey = 'new-secret'
    await nextTick()
    current.value = view({ bucket: 'changed-by-other' })
    await nextTick()
    expect(form.secretAccessKey).toBe('new-secret')
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(true)
  })

  it('改动撤销之后跟上这段时间别人保存的设置', async () => {
    const { current, form, dirty } = start(view())
    form.prefix = 'typing'
    await nextTick()
    current.value = view({ bucket: 'changed-by-other' })
    await nextTick()
    form.prefix = 'kioku'
    await nextTick()
    expect(form.bucket).toBe('changed-by-other')
    expect(dirty.value).toBe(false)
  })

  it('只是备份的状态变了：表单不动，不算有改动', async () => {
    const { current, form, dirty } = start(view())
    current.value = view({
      status: {
        lastSuccess: { at: '2026-11-01T00:00:00.000Z', bytes: 1, object: 'x' },
        lastError: null,
      },
    })
    await nextTick()
    expect(form.bucket).toBe('kioku-backup')
    expect(dirty.value).toBe(false)
  })

  it('自己保存之后按返回的设置同步，正在填的内容不算改动了', async () => {
    const { form, dirty, fill } = start(view())
    form.bucket = 'mine'
    await nextTick()
    fill(view({ bucket: 'mine' }))
    expect(form.bucket).toBe('mine')
    expect(dirty.value).toBe(false)
  })
})
