<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type { BackupRunStatus, BackupSettingsView, BackupTestResult } from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import { classifyError, defaultHour, formatBytes, hourLabel } from '../backup'
import { needsNewKey, newKeyHint } from '../endpointKey'
import { icons } from '../icons'
import { formatRelative, formatTime } from '../time'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsColumns from './strata/SettingsColumns.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const queryKey = ['settings', 'backup']
const objectsKey = ['settings', 'backup', 'objects']

const settings = useQuery({ queryKey, queryFn: api.backupSettings })
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

// 换了接口主机又没填 Secret：服务端会拒（Secret 不能清除），提交之前就在 Secret 旁边说明，保存按钮不可点
const secretMissing = computed(() =>
  needsNewKey({
    baseUrl: form.endpoint,
    savedBaseUrl: view.value?.endpoint ?? null,
    hasApiKey: view.value?.hasSecret ?? false,
    apiKey: form.secretAccessKey,
    clearKey: false,
  }),
)

const saving = ref(false)
async function save() {
  if (secretMissing.value) return
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
watch(
  dirty,
  (changed) => {
    dirtyModel.value = changed
    if (changed) result.value = null
  },
  { immediate: true },
)
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

const problem = computed(() =>
  classifyError(view.value?.status.lastSuccess?.at ?? null, view.value?.status.lastError ?? null),
)

// 点了「立即备份」之后按任务编号每隔几秒查一次这一次做得怎么样，做完了就停（最多等十分钟）
const runId = ref<string | null>(null)
const run = useQuery({
  queryKey: computed(() => ['settings', 'backup', 'run', runId.value]),
  queryFn: () => api.backupRun(runId.value!),
  enabled: computed(() => Boolean(runId.value)),
  refetchInterval: 3_000,
  retry: false,
})
const starting = ref(false)
let alive = true
let giveUp: ReturnType<typeof setTimeout> | undefined
function stopWaiting() {
  runId.value = null
  clearTimeout(giveUp)
}
onBeforeUnmount(() => {
  alive = false
  stopWaiting()
})
async function runNow() {
  if (starting.value || runId.value) return
  starting.value = true
  try {
    const queued = await api.runBackup()
    // 请求回来之前已经离开了这一页：不再等
    if (!alive) return
    runId.value = queued.runId
    giveUp = setTimeout(stopWaiting, 10 * 60_000)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '无法开始备份', color: 'error' })
  } finally {
    starting.value = false
  }
}
const OUTCOMES: Record<
  NonNullable<BackupRunStatus['outcome']>,
  { title: string; color: 'success' | 'error' | 'warning' }
> = {
  done: { title: '备份完成', color: 'success' },
  failed: { title: '备份失败', color: 'error' },
  skipped: { title: '未执行备份：开始时备份设置已被清除', color: 'warning' },
}
// 这一次做完了（或者查不到了）：停下，刷新最近的结果与存储桶里的列表
watch([() => run.data.value, () => run.isError.value], async ([status, failed]) => {
  if (!runId.value || (!failed && status?.state !== 'finished')) return
  stopWaiting()
  if (status?.state === 'finished' && status.outcome) toast.add(OUTCOMES[status.outcome])
  await queryClient.invalidateQueries({ queryKey, exact: true })
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
    // 清掉之后表单回到空白：先按「没有设置」填好界面（之后的刷新出错也不会停在旧的设置上），再去刷新。
    // 存储桶里的列表直接扔掉，不再去列
    synced = false
    queryClient.removeQueries({ queryKey: objectsKey })
    queryClient.setQueryData<BackupSettingsView>(queryKey, {
      configured: false,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      accessKeyId: null,
      hasSecret: false,
      hour: null,
      keep: null,
      status: { lastSuccess: null, lastError: null },
    })
    await queryClient.invalidateQueries({ queryKey, exact: true })
    toast.add({ title: '已清除，定时备份已停止', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '清除失败', color: 'error' })
  } finally {
    clearing.value = false
  }
}
</script>

<template>
  <!-- 后台刷新失败时读到过的设置留着，错误放在上面 -->
  <NoteLine v-if="settings.isError.value" tone="error">
    {{ readFailure(settings.error.value) }}
  </NoteLine>
  <SettingsColumns v-if="!settings.isError.value || view">
    <SettingsBlock title="备份">
      <template #note>
        每天把整个实例加密备份到兼容S3的对象存储。恢复时需配置同一主密钥。
        <Hint>
          支持 MinIO、Cloudflare、Backblaze
          等，存储桶中只保留最近几份。备份使用主密钥派生的密钥加密；恢复步骤见 README。
        </Hint>
      </template>
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
          <UFormField label="区域" help="不确定时使用 us-east-1">
            <UInput v-model="form.region" class="w-full font-mono" required />
          </UFormField>
        </div>
        <UFormField label="目录" help="存储桶中的备份目录，例如 kioku；可留空">
          <UInput v-model="form.prefix" class="w-full font-mono" />
        </UFormField>
        <UFormField label="Access Key ID">
          <UInput v-model="form.accessKeyId" class="w-full font-mono" autocomplete="off" required />
        </UFormField>
        <UFormField
          label="Secret Access Key"
          :help="
            view?.hasSecret
              ? '已加密保存；留空表示不修改，更换接口主机时必须重新填写。'
              : '使用实例主密钥加密保存。'
          "
          :error="secretMissing ? newKeyHint('Secret Access Key', false) : undefined"
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
          <UFormField label="每日备份时间">
            <USelect v-model="form.hour" :items="hours" class="w-full" />
          </UFormField>
          <UFormField label="保留份数" help="更早的备份自动删除">
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
          <UButton
            type="submit"
            color="primary"
            variant="outline"
            :loading="saving"
            :disabled="secretMissing"
            >保存</UButton
          >
          <UButton
            color="neutral"
            variant="outline"
            :loading="testing"
            :disabled="!configured || dirty"
            @click="test"
          >
            测试连接
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            :loading="starting || Boolean(runId)"
            :disabled="!configured || dirty"
            @click="runNow"
          >
            立即备份
          </UButton>
          <UButton
            v-if="configured"
            color="error"
            variant="outline"
            @click="confirmingClear = true"
          >
            清除设置
          </UButton>
          <span v-if="dirty && configured" class="text-muted">保存改动后才能测试和备份</span>
          <span v-if="result" :class="result.ok ? 'text-success' : 'text-error'">
            {{ result.ok ? '连接正常' : result.error }}
          </span>
        </div>
      </form>
    </SettingsBlock>

    <template v-if="configured && view" #side>
      <SettingsBlock title="最近备份">
        <NoteLine v-if="problem" :tone="problem.kind">
          {{ problem.error.message }}
          <template #detail>
            {{ formatTime(problem.error.at) }}（{{ formatRelative(problem.error.at) }}）
          </template>
        </NoteLine>
        <p v-if="view.status.lastSuccess">
          {{ formatTime(view.status.lastSuccess.at) }}（{{
            formatRelative(view.status.lastSuccess.at)
          }}），{{ formatBytes(view.status.lastSuccess.bytes) }}
        </p>
        <p v-else class="text-muted">尚未备份。保存后一小时内生成第一份。</p>
      </SettingsBlock>
      <SettingsBlock title="存储桶中的备份">
        <template #actions>
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
        </template>
        <!-- 刷新失败时读到过的列表留着，错误放在上面 -->
        <NoteLine v-if="objects.isError.value" tone="error">
          {{
            objects.error.value instanceof ApiError ? objects.error.value.message : '无法列出备份'
          }}
        </NoteLine>
        <p v-if="objects.data.value && !objects.data.value.objects.length" class="text-muted">
          暂无备份
        </p>
        <ul v-else-if="objects.data.value" class="-mt-2">
          <li
            v-for="o in objects.data.value.objects"
            :key="o.object"
            class="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-default py-1.5"
          >
            <span class="font-mono text-[13px] break-all">{{ o.object }}</span>
            <span class="shrink-0 text-[13px] text-muted tabular-nums"
              >{{ formatBytes(o.bytes) }} · {{ formatRelative(o.at) }}</span
            >
          </li>
        </ul>
      </SettingsBlock>
    </template>
  </SettingsColumns>

  <UModal
    :open="confirmingClear"
    title="清除备份存储设置？"
    :dismissible="!clearing"
    @update:open="(v) => !v && !clearing && (confirmingClear = false)"
  >
    <template #body>
      <p class="text-sm">清除后不再定时备份。存储桶中已有的备份不受影响，恢复时仍可使用。</p>
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
