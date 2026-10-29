<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { BackupSettingsView, BackupTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { defaultHour, errorKind, formatBytes, hourLabel } from '../backup'
import { icons } from '../icons'
import { formatRelative, formatTime } from '../time'

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'backup']
const objectsKey = ['settings', 'backup', 'objects']

// 点了「立即备份」之后每隔几秒看一眼结果：等的是排上队（服务器时间）之后开始的那一次，
// 别的任务（例如整点的定时备份）的结果不算；最多等十分钟
const waitingFor = ref<string | null>(null)
// 用计算属性而不是函数：函数只在每次取数之后才重新算，查询空闲时开始等待不会触发轮询
const settings = useQuery({
  queryKey,
  queryFn: api.backupSettings,
  refetchInterval: computed(() => (waitingFor.value ? 3_000 : false)),
})
const view = computed(() => settings.data.value)
const configured = computed(() => Boolean(view.value?.configured))
const objects = useQuery({
  queryKey: objectsKey,
  queryFn: api.backupObjects,
  enabled: configured,
  retry: false,
})

const hours = Array.from({ length: 24 }, (_, hour) => ({ label: hourLabel(hour), value: hour }))
const DEFAULT_HOUR = defaultHour()
const DEFAULT_KEEP = 7

// secretAccessKey 留空表示沿用已保存的
const form = reactive({
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: '',
  accessKeyId: '',
  secretAccessKey: '',
  hour: DEFAULT_HOUR,
  keep: DEFAULT_KEEP,
})
const fill = (s: BackupSettingsView) => {
  form.endpoint = s.endpoint ?? ''
  form.region = s.region ?? 'us-east-1'
  form.bucket = s.bucket ?? ''
  form.prefix = s.prefix ?? ''
  form.accessKeyId = s.accessKeyId ?? ''
  form.hour = s.hour ?? DEFAULT_HOUR
  form.keep = s.keep ?? DEFAULT_KEEP
}
// 只在第一次读到、或者自己保存之后同步表单：等结果时的刷新不能冲掉正在填的内容
let synced = false
watch(
  view,
  (s) => {
    if (s && !synced) {
      fill(s)
      synced = true
    }
  },
  { immediate: true },
)

const dirty = computed(() => {
  const s = view.value
  if (!s) return false
  return (
    form.endpoint !== (s.endpoint ?? '') ||
    form.region !== (s.region ?? 'us-east-1') ||
    form.bucket !== (s.bucket ?? '') ||
    form.prefix !== (s.prefix ?? '') ||
    form.accessKeyId !== (s.accessKeyId ?? '') ||
    form.secretAccessKey !== '' ||
    form.hour !== (s.hour ?? DEFAULT_HOUR) ||
    form.keep !== (s.keep ?? DEFAULT_KEEP)
  )
})

const saving = ref(false)
async function save() {
  saving.value = true
  try {
    const saved = await api.saveBackupSettings({
      endpoint: form.endpoint,
      region: form.region,
      bucket: form.bucket,
      prefix: form.prefix,
      accessKeyId: form.accessKeyId,
      ...(form.secretAccessKey ? { secretAccessKey: form.secretAccessKey } : {}),
      hour: form.hour,
      keep: form.keep,
    })
    form.secretAccessKey = ''
    queryClient.setQueryData(queryKey, saved)
    fill(saved)
    result.value = null
    await queryClient.invalidateQueries({ queryKey: objectsKey })
    toast.add({ title: '已保存', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '保存失败', color: 'error' })
  } finally {
    saving.value = false
  }
}

const testing = ref(false)
const result = ref<BackupTestResult | null>(null)
watch(dirty, (changed) => {
  if (changed) result.value = null
})
async function test() {
  testing.value = true
  try {
    result.value = await api.testBackup()
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '测试失败', color: 'error' })
  } finally {
    testing.value = false
  }
}

// 最近一次结果的时间：成功与出错记的都是那一次开始的时间
const lastEvent = computed(() =>
  [view.value?.status.lastSuccess?.at, view.value?.status.lastError?.at]
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1),
)
const lastErrorKind = computed(() =>
  errorKind(view.value?.status.lastSuccess?.at ?? null, view.value?.status.lastError ?? null),
)
const starting = ref(false)
let giveUp: ReturnType<typeof setTimeout> | undefined
function stopWaiting() {
  waitingFor.value = null
  clearTimeout(giveUp)
}
onBeforeUnmount(stopWaiting)
async function runNow() {
  if (starting.value || waitingFor.value) return
  starting.value = true
  try {
    const { queuedAt } = await api.runBackup()
    waitingFor.value = queuedAt
    giveUp = setTimeout(stopWaiting, 10 * 60_000)
    toast.add({ title: '已排进后台任务，做完会在下面显示', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '没能开始备份', color: 'error' })
  } finally {
    starting.value = false
  }
}
watch(lastEvent, async (at) => {
  if (!waitingFor.value || !at || at < waitingFor.value) return
  stopWaiting()
  await queryClient.invalidateQueries({ queryKey: objectsKey })
})

const confirmingClear = ref(false)
const clearing = ref(false)
async function clear() {
  clearing.value = true
  try {
    await api.clearBackupSettings()
    confirmingClear.value = false
    result.value = null
    stopWaiting()
    form.secretAccessKey = ''
    // 清掉之后表单回到空白：刷新回来时按新的（空的）设置重新填。存储桶里的列表直接扔掉，不再去列
    synced = false
    queryClient.removeQueries({ queryKey: objectsKey })
    await queryClient.invalidateQueries({ queryKey, exact: true })
    toast.add({ title: '已清除，定时备份停止', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="font-medium">备份</h2>
      <p class="mt-1 text-sm text-muted">
        每天定时把整个实例加密备份到兼容S3的对象存储（MinIO、Cloudflare、Backblaze
        等），存储桶里只留最近几份。备份用主密钥派生的密钥加密，恢复时要配同一把主密钥；恢复的步骤见
        README。
      </p>
    </template>
    <UAlert
      v-if="settings.isError.value && !view"
      color="error"
      variant="subtle"
      :title="settings.error.value instanceof ApiError ? settings.error.value.message : '读取失败'"
    />
    <div v-else class="space-y-5">
      <form class="space-y-4" @submit.prevent="save">
        <UFormField
          label="接口地址"
          help="对象存储的接口地址（兼容S3），例如 https://s3.example.com"
        >
          <UInput v-model="form.endpoint" class="w-full font-mono" required />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="存储桶">
            <UInput v-model="form.bucket" class="w-full font-mono" required />
          </UFormField>
          <UFormField label="区域" help="不清楚就用 us-east-1">
            <UInput v-model="form.region" class="w-full font-mono" required />
          </UFormField>
        </div>
        <UFormField label="目录" help="备份放在存储桶的这个目录下，例如 kioku；可以不填">
          <UInput v-model="form.prefix" class="w-full font-mono" />
        </UFormField>
        <UFormField label="Access Key ID">
          <UInput v-model="form.accessKeyId" class="w-full font-mono" autocomplete="off" required />
        </UFormField>
        <UFormField
          label="Secret Access Key"
          :help="
            view?.hasSecret
              ? '已保存（加密存储）。留空表示不修改；更换了接口主机时必须重新填写'
              : '用实例主密钥加密后存库'
          "
        >
          <UInput
            v-model="form.secretAccessKey"
            type="password"
            autocomplete="off"
            class="w-full"
            :required="!view?.hasSecret"
          />
        </UFormField>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="每天几点备份">
            <USelect v-model="form.hour" :items="hours" class="w-full" />
          </UFormField>
          <UFormField label="留几份" help="更早的自动删掉">
            <UInput
              v-model.number="form.keep"
              type="number"
              :min="1"
              :max="365"
              class="w-full"
              required
            />
          </UFormField>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton type="submit" :icon="icons.save" :loading="saving">保存</UButton>
          <UButton
            :icon="icons.test"
            color="neutral"
            variant="subtle"
            :loading="testing"
            :disabled="!configured || dirty"
            @click="test"
          >
            测试连通
          </UButton>
          <UButton
            :icon="icons.backup"
            color="neutral"
            variant="subtle"
            :loading="starting || Boolean(waitingFor)"
            :disabled="!configured || dirty"
            @click="runNow"
          >
            立即备份
          </UButton>
          <UButton v-if="configured" color="error" variant="ghost" @click="confirmingClear = true">
            清除设置
          </UButton>
          <span v-if="dirty && configured" class="text-sm text-muted"
            >改动保存之后才能测试和备份</span
          >
          <span v-if="result" class="text-sm" :class="result.ok ? 'text-success' : 'text-error'">
            {{ result.ok ? '正常：放、列、删都可以' : result.error }}
          </span>
        </div>
      </form>

      <template v-if="configured && view">
        <USeparator />
        <div class="space-y-3 text-sm">
          <UAlert
            v-if="view.status.lastError && lastErrorKind"
            :color="lastErrorKind"
            variant="subtle"
            :title="view.status.lastError.message"
            :description="`${formatTime(view.status.lastError.at)}（${formatRelative(view.status.lastError.at)}）`"
          />
          <p v-if="view.status.lastSuccess">
            最近一份：{{ formatTime(view.status.lastSuccess.at) }}（{{
              formatRelative(view.status.lastSuccess.at)
            }}），{{ formatBytes(view.status.lastSuccess.bytes) }}
          </p>
          <p v-else class="text-muted">还没做过备份：保存之后一个小时内会做第一份。</p>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <span class="font-medium">存储桶里的备份</span>
              <UButton
                :icon="icons.refresh"
                size="xs"
                color="neutral"
                variant="ghost"
                :loading="objects.isFetching.value"
                @click="objects.refetch()"
              >
                刷新
              </UButton>
            </div>
            <p v-if="objects.isError.value" class="text-error">
              {{
                objects.error.value instanceof ApiError ? objects.error.value.message : '列不出来'
              }}
            </p>
            <p
              v-else-if="objects.data.value && !objects.data.value.objects.length"
              class="text-muted"
            >
              还没有
            </p>
            <ul v-else-if="objects.data.value" class="divide-y divide-default">
              <li
                v-for="o in objects.data.value.objects"
                :key="o.object"
                class="flex flex-wrap items-baseline justify-between gap-x-4 py-1.5"
              >
                <span class="font-mono text-xs break-all">{{ o.object }}</span>
                <span class="shrink-0 text-xs text-muted tabular-nums"
                  >{{ formatBytes(o.bytes) }} · {{ formatRelative(o.at) }}</span
                >
              </li>
            </ul>
          </div>
        </div>
      </template>
    </div>
  </UCard>

  <UModal
    :open="confirmingClear"
    title="清除备份存储的设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">清除之后不再定时备份。存储桶里已有的备份不动，恢复时照样用得上。</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="clearing"
          @click="confirmingClear = false"
          >取消</UButton
        >
        <UButton color="error" :loading="clearing" @click="clear">清除</UButton>
      </div>
    </template>
  </UModal>
</template>
