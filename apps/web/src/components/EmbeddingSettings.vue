<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type {
  EmbeddingChannelTest,
  EmbeddingSetupView,
  EmbeddingTestResult,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { followEmbedding, profileIdsChanged, switchTracker } from '../embeddingDrafts'
import { icons } from '../icons'
import { flattenProfiles } from '../models'
import Hint from './Hint.vue'
import ModelChainEditor from './ModelChainEditor.vue'
import NoteLine from './strata/NoteLine.vue'
import ReadFailureNote from './strata/ReadFailureNote.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsColumns from './strata/SettingsColumns.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

const toast = useToast()
const queryClient = useQueryClient()
const POLL_INTERVAL_MS = 5_000
const failed = (err: unknown, fallback: string) =>
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })

const registry = useQuery({ queryKey: ['settings', 'models'], queryFn: api.modelRegistry })
const embeddingOptions = computed(() =>
  flattenProfiles(registry.data.value?.providers ?? [], 'embedding'),
)

// 正在换模型时一直跟进：后台补齐后会自动切过去，设置与进度都会变
const settings = useQuery({
  queryKey: ['settings', 'embedding'],
  queryFn: api.embeddingSettings,
  refetchInterval: (query) => (query.state.data?.next ? POLL_INTERVAL_MS : false),
})
const active = computed(() => settings.data.value?.active ?? null)
const next = computed(() => settings.data.value?.next ?? null)

const status = useQuery({
  queryKey: ['settings', 'embedding', 'status'],
  queryFn: api.embeddingStatus,
  refetchInterval: (query) => (followEmbedding(query.state.data) ? POLL_INTERVAL_MS : false),
})
const following = computed(() => followEmbedding(status.data.value))
const percent = (embedded: number) => {
  const eligible = status.data.value?.eligible ?? 0
  return eligible ? Math.round((embedded / eligible) * 100) : null
}
const errorOf = (model: string | undefined) => {
  const e = status.data.value?.lastError
  return e && e.model === model ? e : null
}
const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['settings', 'embedding'] }),
    queryClient.invalidateQueries({ queryKey: ['instance-system'] }),
  ])

// 正在用的模型：模型标识只在第一次配置时填，之后要换就走换模型
const modelId = ref('')
const activeProfileIds = ref<string[]>([])
let syncedActive = ''
function syncActive(value: EmbeddingSetupView | null) {
  syncedActive = JSON.stringify(value)
  modelId.value = value?.model ?? ''
  activeProfileIds.value = value ? [...value.profileIds] : []
}
watch(
  active,
  (value, previous) => {
    if (JSON.stringify(value) === syncedActive) return
    const discarded = previous
      ? profileIdsChanged(activeProfileIds.value, previous.profileIds)
      : false
    syncActive(value)
    if (discarded) {
      toast.add({ title: '嵌入设置已在后台更新，未保存的渠道改动已丢弃', color: 'warning' })
    }
  },
  { immediate: true },
)
watch(
  activeProfileIds,
  (ids) => {
    if (active.value || modelId.value.trim() || !ids.length) return
    const first = embeddingOptions.value.find((o) => o.profileId === ids[0])
    if (first) modelId.value = first.model
  },
  { deep: false },
)
const activeDirty = computed(() =>
  active.value
    ? profileIdsChanged(activeProfileIds.value, active.value.profileIds)
    : modelId.value !== '' || activeProfileIds.value.length > 0,
)
const saving = ref(false)
async function saveActive() {
  if (!activeProfileIds.value.length) return
  const first = !active.value
  saving.value = true
  try {
    const saved = await api.saveEmbeddingSettings({
      model: modelId.value.trim(),
      profileIds: activeProfileIds.value,
    })
    syncActive(saved.active)
    await refresh()
    toast.add({
      title: first ? '已保存，后台将为全部记忆生成向量' : '已保存',
      color: 'success',
    })
  } catch (err) {
    failed(err, '保存失败')
  } finally {
    saving.value = false
  }
}

// 换模型：新模型的标识与渠道引用
const starting = ref(false)
const nextModel = ref('')
const nextProfileIds = ref<string[]>([])
let syncedNext = ''
function syncNext(value: EmbeddingSetupView | null) {
  syncedNext = JSON.stringify(value)
  if (!value) return
  nextModel.value = value.model
  nextProfileIds.value = [...value.profileIds]
  starting.value = false
}
watch(
  next,
  (value, previous) => {
    if (JSON.stringify(value) === syncedNext) return
    const discarded = previous
      ? profileIdsChanged(nextProfileIds.value, previous.profileIds)
      : false
    syncNext(value)
    if (discarded) {
      toast.add({ title: '更换模型的设置已在后台更新，未保存的渠道改动已丢弃', color: 'warning' })
    }
  },
  { immediate: true },
)

const sawSwitch = switchTracker()
let ending: 'switch' | 'abort' | null = null
watch(
  () => settings.dataUpdatedAt.value,
  () => {
    const ended = sawSwitch(settings.isFetchedAfterMount.value, next.value, active.value)
    if (!ended) return
    const own = ending !== null
    ending = null
    if (!own) void status.refetch({ cancelRefetch: false })
    if (ended === 'switched') {
      toast.add({
        title: `已切换到 ${active.value?.model}，旧模型的向量将在后台删除`,
        color: 'success',
      })
    } else if (!own) {
      toast.add({ title: '已放弃更换模型（可能由其他管理员操作）', color: 'warning' })
    }
  },
)
function openStart() {
  nextModel.value = ''
  nextProfileIds.value = []
  starting.value = true
}
watch(
  nextProfileIds,
  (ids) => {
    if (!starting.value || nextModel.value.trim() || !ids.length) return
    const first = embeddingOptions.value.find((o) => o.profileId === ids[0])
    if (first) nextModel.value = first.model
  },
  { deep: false },
)
const nextDirty = computed(() =>
  next.value
    ? profileIdsChanged(nextProfileIds.value, next.value.profileIds)
    : starting.value && (nextModel.value !== '' || nextProfileIds.value.length > 0),
)
const confirmStart = ref(false)
function askStart() {
  if (!nextProfileIds.value.length) return
  confirmStart.value = true
}
const savingNext = ref(false)
async function saveNext() {
  if (!nextProfileIds.value.length) {
    confirmStart.value = false
    return
  }
  const begin = !next.value
  savingNext.value = true
  try {
    const saved = await api.saveNextEmbedding({
      model: nextModel.value.trim(),
      profileIds: nextProfileIds.value,
    })
    syncNext(saved.next)
    await refresh()
    toast.add({
      title: begin ? '已开始更换模型，后台将为全部记忆生成新模型的向量' : '已保存',
      color: 'success',
    })
  } catch (err) {
    failed(err, '保存失败')
  } finally {
    savingNext.value = false
    confirmStart.value = false
  }
}

const retrying = ref(false)
async function retryNext() {
  retrying.value = true
  try {
    await api.retryNextEmbedding()
    toast.add({ title: '已加入队列，后台将继续补齐新模型的向量', color: 'success' })
  } catch (err) {
    failed(err, '加入队列失败')
  } finally {
    retrying.value = false
  }
}

const confirmSwitch = ref(false)
const switching = ref(false)
async function switchNow() {
  switching.value = true
  ending = 'switch'
  try {
    await api.switchEmbedding()
    await refresh()
  } catch (err) {
    ending = null
    failed(err, '切换失败')
  } finally {
    switching.value = false
    confirmSwitch.value = false
  }
}
const confirmAbort = ref(false)
const aborting = ref(false)
async function abort() {
  aborting.value = true
  ending = 'abort'
  try {
    await api.abortNextEmbedding()
    await refresh()
    toast.add({ title: '已放弃更换模型，新模型的向量将在后台删除', color: 'success' })
  } catch (err) {
    ending = null
    failed(err, '放弃失败')
  } finally {
    aborting.value = false
    confirmAbort.value = false
  }
}
const remaining = computed(() => {
  const s = status.data.value
  return s?.next ? Math.max(0, s.eligible - s.next.embedded) : 0
})

const testing = ref(false)
const result = ref<EmbeddingTestResult | null>(null)
watch(
  [activeDirty, nextDirty],
  ([a, n]) => {
    dirtyModel.value = a || n
    if (a || n) result.value = null
  },
  { immediate: true },
)
async function test() {
  testing.value = true
  try {
    result.value = await api.testEmbedding()
  } catch (err) {
    failed(err, '测试失败')
  } finally {
    testing.value = false
  }
}
function describe(test: EmbeddingChannelTest): string {
  if (!test.ok) return test.error ?? '失败'
  const parts = [`连接正常，耗时 ${test.latencyMs} ms`]
  if (test.similarity !== null) {
    parts.push(`与首个可用渠道的相似度 ${test.similarity}`)
    if (test.similarity < 0.99) parts.push('可能不是同一模型')
  }
  return parts.join('，')
}

const rebuilding = ref(false)
async function rebuild() {
  rebuilding.value = true
  try {
    await api.rebuildEmbeddings()
    toast.add({ title: '已加入队列，后台将检查全部记忆，补齐缺失或过时的向量', color: 'success' })
    void status.refetch({ cancelRefetch: false })
  } catch (err) {
    failed(err, '加入队列失败')
  } finally {
    rebuilding.value = false
  }
}
</script>

<template>
  <SettingsColumns>
    <SettingsBlock title="嵌入模型">
      <template #note>
        从已配置的嵌入模型中选择备选渠道，向量维度固定为
        {{ settings.data.value?.dimensions ?? 1024 }}。
        <Hint>
          整个实例共用一个模型。可按顺序选择多个渠道（同一向量空间的不同服务商），前一个出错时切换到下一个。
        </Hint>
      </template>
      <ReadFailureNote v-if="settings.isError.value" :query="settings" />
      <USkeleton v-if="settings.isPending.value" class="h-40 w-full" />
      <form v-else-if="settings.data.value" class="space-y-4" @submit.prevent="saveActive">
        <UFormField
          label="模型标识"
          :help="
            active
              ? '用于区分向量空间的逻辑名称（同一模型的多个渠道共用）；更换模型请使用下方的「更换模型」。'
              : '用于区分向量空间的逻辑名称（例如 text-embedding-3-large），同一模型的不同渠道共用此标识；首次选好模型后会自动填入，可按需修改。'
          "
        >
          <UInput
            v-model="modelId"
            placeholder="例如 text-embedding-3-large"
            class="w-full font-mono"
            :disabled="!!active"
            required
          />
        </UFormField>
        <ModelChainEditor
          v-model="activeProfileIds"
          :options="embeddingOptions"
          :min="active ? 1 : 0"
          empty-hint="请先在上方「模型服务商」中添加嵌入模型。"
        />
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            type="submit"
            color="primary"
            variant="outline"
            :loading="saving"
            :disabled="!activeDirty || !activeProfileIds.length"
            >保存</UButton
          >
          <UButton
            color="neutral"
            variant="outline"
            :loading="testing"
            :disabled="!active || activeDirty || nextDirty"
            @click="test"
          >
            测试连接
          </UButton>
          <span v-if="active && (activeDirty || nextDirty)" class="text-muted"
            >保存改动后才能测试</span
          >
        </div>
        <ul v-if="result?.active" class="space-y-1">
          <li
            v-for="(item, i) in result.active"
            :key="i"
            :class="item.ok && (item.similarity ?? 1) >= 0.99 ? 'text-success' : 'text-error'"
          >
            渠道 {{ i + 1 }}：{{ describe(item) }}
          </li>
        </ul>
      </form>
    </SettingsBlock>

    <SettingsBlock v-if="active" title="更换模型">
      <template #note>
        后台为全部记忆生成新模型的向量，补齐后自动切换。
        <Hint>补齐前召回继续使用 {{ active.model }}；切换后删除旧模型的向量。</Hint>
      </template>
      <div v-if="next" class="space-y-4">
        <div class="space-y-2">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span>正在更换为</span>
            <span class="font-mono font-medium break-all">{{ next.model }}</span>
          </div>
          <template v-if="status.data.value?.next">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-xl tabular-nums">
                {{ status.data.value.next.embedded }} / {{ status.data.value.eligible }}
              </span>
              <span class="text-muted">条记忆已有新模型的向量</span>
            </div>
            <UProgress
              v-if="percent(status.data.value.next.embedded) !== null"
              :model-value="percent(status.data.value.next.embedded)!"
            />
          </template>
          <NoteLine v-if="errorOf(next.model)" tone="error">
            {{ errorOf(next.model)!.message }}
          </NoteLine>
        </div>
        <form class="space-y-4" @submit.prevent="saveNext">
          <ModelChainEditor v-model="nextProfileIds" :options="embeddingOptions" :min="1" />
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              type="submit"
              color="primary"
              variant="outline"
              :loading="savingNext"
              :disabled="!nextDirty || !nextProfileIds.length"
              >保存</UButton
            >
            <UButton
              v-if="errorOf(next.model)"
              color="neutral"
              variant="outline"
              :loading="retrying"
              :disabled="nextDirty"
              @click="retryNext"
            >
              重试
            </UButton>
            <UButton
              color="neutral"
              variant="outline"
              :disabled="nextDirty"
              @click="confirmSwitch = true"
            >
              立即切换
            </UButton>
            <UButton
              color="error"
              variant="outline"
              :disabled="nextDirty"
              @click="confirmAbort = true"
            >
              放弃
            </UButton>
          </div>
          <ul v-if="result?.next" class="space-y-1">
            <li
              v-for="(item, i) in result.next"
              :key="i"
              :class="item.ok && (item.similarity ?? 1) >= 0.99 ? 'text-success' : 'text-error'"
            >
              渠道 {{ i + 1 }}：{{ describe(item) }}
            </li>
          </ul>
        </form>
      </div>
      <form v-else-if="starting" class="space-y-4" @submit.prevent="askStart">
        <UFormField label="新模型的标识" help="须与当前标识不同；向量按此标识存储。">
          <UInput v-model="nextModel" class="w-full font-mono" required />
        </UFormField>
        <ModelChainEditor v-model="nextProfileIds" :options="embeddingOptions" :min="0" />
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            type="submit"
            color="primary"
            variant="outline"
            :disabled="!nextModel.trim() || !nextProfileIds.length"
            >开始更换模型</UButton
          >
          <UButton color="neutral" variant="ghost" @click="starting = false">取消</UButton>
        </div>
      </form>
      <UButton v-else color="neutral" variant="outline" @click="openStart">更换模型…</UButton>
    </SettingsBlock>

    <template #side>
      <SettingsBlock title="向量">
        <template #note>
          显示已生成当前模型向量的记忆数量。
          <Hint>
            统计范围为全实例当前有效、非机密、有正文的记忆。已过期的记忆不再召回，也不生成向量，恢复生效后再生成。新写入的记忆自动排队；接口出错后可以手动补齐。
          </Hint>
        </template>
        <ReadFailureNote v-if="status.isError.value" :query="status" />
        <div v-if="status.data.value" class="space-y-3">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-xl tabular-nums">
              {{ status.data.value.active?.embedded ?? 0 }} / {{ status.data.value.eligible }}
            </span>
            <span class="text-muted">
              {{
                status.data.value.active
                  ? `模型 ${status.data.value.active.model}`
                  : '尚未配置嵌入模型'
              }}
            </span>
          </div>
          <UProgress
            v-if="status.data.value.active && percent(status.data.value.active.embedded) !== null"
            :model-value="percent(status.data.value.active.embedded)!"
          />
          <NoteLine v-if="errorOf(status.data.value.active?.model)" tone="error">
            {{ errorOf(status.data.value.active?.model)!.message }}
          </NoteLine>
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :loading="rebuilding"
              :disabled="!status.data.value.active"
              @click="rebuild"
            >
              补齐向量
            </UButton>
            <UButton
              :icon="icons.refresh"
              color="neutral"
              variant="ghost"
              :loading="status.isRefetching.value"
              @click="status.refetch()"
            >
              刷新
            </UButton>
            <span v-if="following" class="text-muted">正在刷新进度…</span>
          </div>
        </div>
      </SettingsBlock>
    </template>
  </SettingsColumns>

  <UModal
    :open="confirmStart"
    title="开始更换模型？"
    :dismissible="!savingNext"
    :close="!savingNext"
    @update:open="(v) => (!v && savingNext) || (confirmStart = v)"
  >
    <template #body>
      <p class="text-sm">
        后台将为全部记忆生成 {{ nextModel }} 的向量，产生大量接口请求。补齐前召回继续使用
        {{ active?.model }}，补齐后自动切换并删除旧模型的向量。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="savingNext"
          @click="confirmStart = false"
          >取消</UButton
        >
        <UButton :loading="savingNext" @click="saveNext">开始</UButton>
      </div>
    </template>
  </UModal>
  <UModal
    :open="confirmSwitch"
    title="立即切换？"
    :dismissible="!switching"
    :close="!switching"
    @update:open="(v) => (!v && switching) || (confirmSwitch = v)"
  >
    <template #body>
      <p class="text-sm">
        <template v-if="remaining">
          还有 {{ remaining }} 条记忆没有
          {{ next?.model }} 的向量，切换后这些记忆暂时只能通过全文与关键词召回，后台会继续补齐。
        </template>
        <template v-else>切换到 {{ next?.model }}。</template>
        {{ active?.model }} 的向量将被删除。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="switching"
          @click="confirmSwitch = false"
          >取消</UButton
        >
        <UButton :loading="switching" @click="switchNow">切换</UButton>
      </div>
    </template>
  </UModal>
  <UModal
    :open="confirmAbort"
    title="放弃更换模型？"
    :dismissible="!aborting"
    :close="!aborting"
    @update:open="(v) => (!v && aborting) || (confirmAbort = v)"
  >
    <template #body>
      <p class="text-sm">
        {{ next?.model }} 已生成的向量将被删除，召回继续使用 {{ active?.model }}。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="aborting" @click="confirmAbort = false"
          >取消</UButton
        >
        <UButton color="error" :loading="aborting" @click="abort">放弃</UButton>
      </div>
    </template>
  </UModal>
</template>
