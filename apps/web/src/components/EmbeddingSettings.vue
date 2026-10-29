<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type {
  EmbeddingChannelTest,
  EmbeddingSetupView,
  EmbeddingTestResult,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { draftOf, draftsChanged, inputOf, type ChannelDraft } from '../embeddingDrafts'
import { icons } from '../icons'
import EmbeddingChannels from './EmbeddingChannels.vue'

const toast = useToast()
const queryClient = useQueryClient()
const POLL_INTERVAL_MS = 5_000
const failed = (err: unknown, fallback: string) =>
  toast.add({ title: err instanceof ApiError ? err.message : fallback, color: 'error' })

// 正在换模型时一直跟进：后台补齐后会自动切过去，设置与进度都会变
const settings = useQuery({
  queryKey: ['settings', 'embedding'],
  queryFn: api.embeddingSettings,
  refetchInterval: (query) => (query.state.data?.next ? POLL_INTERVAL_MS : false),
})
const active = computed(() => settings.data.value?.active ?? null)
const next = computed(() => settings.data.value?.next ?? null)

// 保存或补齐之后的一段时间里也刷新进度
const POLL_DURATION_MS = 120_000
const polling = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(pollTimer))
function startPolling() {
  polling.value = true
  clearTimeout(pollTimer)
  pollTimer = setTimeout(() => (polling.value = false), POLL_DURATION_MS)
}
const status = useQuery({
  queryKey: ['settings', 'embedding', 'status'],
  queryFn: api.embeddingStatus,
  refetchInterval: computed(() => (next.value || polling.value ? POLL_INTERVAL_MS : false)),
})
const percent = (embedded: number) => {
  const eligible = status.data.value?.eligible ?? 0
  return eligible ? Math.round((embedded / eligible) * 100) : null
}
const errorOf = (model: string | undefined) => {
  const e = status.data.value?.lastError
  return e && e.model === model ? e : null
}
const refresh = () => queryClient.invalidateQueries({ queryKey: ['settings', 'embedding'] })

// 正在用的模型：模型标识只在第一次配置时填，之后要换就走换模型
const modelId = ref('')
const activeDrafts = ref<ChannelDraft[]>([draftOf()])
let syncedActive = ''
function syncActive(value: EmbeddingSetupView | null) {
  syncedActive = JSON.stringify(value)
  modelId.value = value?.model ?? ''
  activeDrafts.value = value ? value.channels.map(draftOf) : [draftOf()]
}
watch(
  active,
  (value, previous) => {
    // 跟进进度时设置每隔几秒读一次，内容没变就不重填，不冲掉正在编辑的内容；自己保存的已经按返回的同步过了
    if (JSON.stringify(value) === syncedActive) return
    // 设置在后台变了（例如换模型补齐后自动切过去）：没保存的改动对不上新的设置，丢掉并说一声
    const discarded = previous ? draftsChanged(activeDrafts.value, previous.channels) : false
    syncActive(value)
    if (discarded) {
      toast.add({ title: '嵌入设置在后台变了，没保存的渠道改动已经丢掉', color: 'warning' })
    }
  },
  { immediate: true },
)
const activeDirty = computed(() =>
  active.value
    ? draftsChanged(activeDrafts.value, active.value.channels)
    : modelId.value !== '' || activeDrafts.value.some((d) => d.baseUrl || d.model || d.apiKey),
)
const saving = ref(false)
async function saveActive() {
  const first = !active.value
  saving.value = true
  try {
    const saved = await api.saveEmbeddingSettings({
      model: modelId.value.trim(),
      channels: activeDrafts.value.map(inputOf),
    })
    syncActive(saved.active)
    await refresh()
    toast.add({
      title: first ? '已保存，后台会为全部记忆生成向量' : '已保存',
      color: 'success',
    })
    if (first) startPolling()
  } catch (err) {
    failed(err, '保存失败')
  } finally {
    saving.value = false
  }
}

// 换模型：新模型的标识与渠道。开始时照抄现在的渠道（同一主机沿用已保存的 Key），请求用的模型名留空让管理员填
const starting = ref(false)
const nextModel = ref('')
const nextDrafts = ref<ChannelDraft[]>([])
let syncedNext = ''
function syncNext(value: EmbeddingSetupView | null) {
  syncedNext = JSON.stringify(value)
  if (!value) return
  nextModel.value = value.model
  nextDrafts.value = value.channels.map(draftOf)
  starting.value = false
}
watch(
  next,
  (value, previous) => {
    if (JSON.stringify(value) === syncedNext) return
    const discarded = previous ? draftsChanged(nextDrafts.value, previous.channels) : false
    syncNext(value)
    if (!value && previous && active.value?.model === previous.model) {
      toast.add({ title: `已换成 ${previous.model}，旧模型的向量会在后台删掉`, color: 'success' })
    }
    if (discarded) {
      toast.add({ title: '换模型的设置在后台变了，没保存的渠道改动已经丢掉', color: 'warning' })
    }
  },
  { immediate: true },
)
function openStart() {
  nextModel.value = ''
  nextDrafts.value = (active.value?.channels ?? []).map((c) => ({ ...draftOf(c), model: '' }))
  starting.value = true
}
const nextDirty = computed(() =>
  next.value
    ? draftsChanged(nextDrafts.value, next.value.channels)
    : starting.value && nextModel.value !== '',
)
const confirmStart = ref(false)
const savingNext = ref(false)
async function saveNext() {
  const begin = !next.value
  savingNext.value = true
  try {
    const saved = await api.saveNextEmbedding({
      model: nextModel.value.trim(),
      channels: nextDrafts.value.map(inputOf),
    })
    syncNext(saved.next)
    await refresh()
    toast.add({
      title: begin ? '开始换模型：后台为全部记忆生成新模型的向量' : '已保存',
      color: 'success',
    })
  } catch (err) {
    failed(err, '保存失败')
  } finally {
    savingNext.value = false
    confirmStart.value = false
  }
}

// 马上再补一遍新模型的向量（例如修好了渠道之后），不用等定时任务
const retrying = ref(false)
async function retryNext() {
  retrying.value = true
  try {
    await api.retryNextEmbedding()
    toast.add({ title: '已排进队列，后台会接着补新模型的向量', color: 'success' })
  } catch (err) {
    failed(err, '排队失败')
  } finally {
    retrying.value = false
  }
}

const confirmSwitch = ref(false)
const switching = ref(false)
async function switchNow() {
  switching.value = true
  try {
    await api.switchEmbedding()
    await refresh()
  } catch (err) {
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
  try {
    await api.abortNextEmbedding()
    await refresh()
    toast.add({ title: '已放弃换模型，新模型生成的向量会在后台删掉', color: 'success' })
  } catch (err) {
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

// 「测试连通」测的是已保存的设置：有没保存的改动时先保存再测，改动之后旧的测试结果也不再显示
const testing = ref(false)
const result = ref<EmbeddingTestResult | null>(null)
watch([activeDirty, nextDirty], ([a, n]) => {
  if (a || n) result.value = null
})
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
  const parts = [`正常，耗时 ${test.latencyMs} ms`]
  if (test.similarity !== null) {
    parts.push(`和第一个通了的渠道相似度 ${test.similarity}`)
    if (test.similarity < 0.99) parts.push('可能不是同一个模型')
  }
  return parts.join('，')
}

const rebuilding = ref(false)
async function rebuild() {
  rebuilding.value = true
  try {
    await api.rebuildEmbeddings()
    toast.add({ title: '已排进队列，后台会检查全部记忆、补齐缺少或过时的向量', color: 'success' })
    startPolling()
  } catch (err) {
    failed(err, '排队失败')
  } finally {
    rebuilding.value = false
  }
}
</script>

<template>
  <UAlert
    v-if="settings.isError.value"
    color="error"
    variant="subtle"
    :title="
      settings.error.value instanceof ApiError ? settings.error.value.message : '读取设置失败'
    "
  />
  <UCard>
    <template #header>
      <h2 class="font-medium">嵌入模型</h2>
      <p class="mt-1 text-sm text-muted">
        OpenAI 兼容的 /embeddings 接口，需要支持 dimensions 参数，向量维度固定为
        {{
          settings.data.value?.dimensions ?? 1024
        }}。整个实例共用一个模型；可以配几个渠道（同一个模型的不同接口），按顺序请求，前一个出错时换下一个。
      </p>
    </template>
    <form class="space-y-4" @submit.prevent="saveActive">
      <UFormField
        label="模型标识"
        :help="
          active ? '向量按它存；要换成别的模型，用下面的「换模型」' : '向量按它存，例如模型的名字'
        "
      >
        <UInput v-model="modelId" class="w-full font-mono" :disabled="!!active" required />
      </UFormField>
      <EmbeddingChannels v-model="activeDrafts" />
      <div class="flex flex-wrap items-center gap-2">
        <UButton type="submit" :icon="icons.save" :loading="saving" :disabled="!activeDirty"
          >保存</UButton
        >
        <UButton
          :icon="icons.test"
          color="neutral"
          variant="subtle"
          :loading="testing"
          :disabled="!active || activeDirty || nextDirty"
          @click="test"
        >
          测试连通
        </UButton>
        <span v-if="active && (activeDirty || nextDirty)" class="text-sm text-muted"
          >改动保存之后才能测试</span
        >
      </div>
      <ul v-if="result?.active" class="space-y-1 text-sm">
        <li
          v-for="(item, i) in result.active"
          :key="i"
          :class="item.ok && (item.similarity ?? 1) >= 0.99 ? 'text-success' : 'text-error'"
        >
          渠道 {{ i + 1 }}：{{ describe(item) }}
        </li>
      </ul>
    </form>
  </UCard>

  <UCard v-if="active">
    <template #header>
      <h2 class="font-medium">换模型</h2>
      <p class="mt-1 text-sm text-muted">
        换成另一个模型：后台为全部记忆生成新模型的向量，召回在补齐之前一直用
        {{ active.model }}，补齐后自动切过去、删掉旧模型的向量。
      </p>
    </template>
    <div v-if="next" class="space-y-4">
      <div class="space-y-2">
        <div class="flex items-baseline gap-2">
          <span class="text-sm">正在换成</span>
          <span class="font-mono font-medium">{{ next.model }}</span>
        </div>
        <template v-if="status.data.value?.next">
          <div class="flex items-baseline gap-2">
            <span class="text-2xl font-semibold tabular-nums">
              {{ status.data.value.next.embedded }} / {{ status.data.value.eligible }}
            </span>
            <span class="text-sm text-muted">条记忆已有新模型的向量</span>
          </div>
          <UProgress
            v-if="percent(status.data.value.next.embedded) !== null"
            :model-value="percent(status.data.value.next.embedded)!"
          />
        </template>
        <UAlert
          v-if="errorOf(next.model)"
          color="error"
          variant="subtle"
          :title="errorOf(next.model)!.message"
        />
      </div>
      <form class="space-y-4" @submit.prevent="saveNext">
        <EmbeddingChannels v-model="nextDrafts" />
        <div class="flex flex-wrap items-center gap-2">
          <UButton type="submit" :icon="icons.save" :loading="savingNext" :disabled="!nextDirty"
            >保存</UButton
          >
          <UButton
            v-if="errorOf(next.model)"
            :icon="icons.refresh"
            color="neutral"
            variant="subtle"
            :loading="retrying"
            :disabled="nextDirty"
            @click="retryNext"
          >
            重试
          </UButton>
          <UButton
            :icon="icons.moved"
            color="neutral"
            variant="subtle"
            :disabled="nextDirty"
            @click="confirmSwitch = true"
          >
            现在切换
          </UButton>
          <UButton
            :icon="icons.cancel"
            color="neutral"
            variant="ghost"
            :disabled="nextDirty"
            @click="confirmAbort = true"
          >
            放弃
          </UButton>
        </div>
        <ul v-if="result?.next" class="space-y-1 text-sm">
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
    <form v-else-if="starting" class="space-y-4" @submit.prevent="confirmStart = true">
      <UFormField label="新模型的标识" help="和现在的不同；向量按它存">
        <UInput v-model="nextModel" class="w-full font-mono" required />
      </UFormField>
      <EmbeddingChannels v-model="nextDrafts" />
      <div class="flex flex-wrap items-center gap-2">
        <UButton type="submit" :icon="icons.moved">开始换模型</UButton>
        <UButton color="neutral" variant="ghost" @click="starting = false">取消</UButton>
      </div>
    </form>
    <UButton v-else :icon="icons.moved" color="neutral" variant="subtle" @click="openStart"
      >换模型…</UButton
    >
  </UCard>

  <UCard>
    <template #header>
      <h2 class="font-medium">向量</h2>
      <p class="mt-1 text-sm text-muted">
        整个实例里应当有向量的记忆（没删除、不是
        secret、有正文）有多少已经有现在这个模型的向量。新写入的记忆会自动排队；接口出过错之后，可以手动补齐。
      </p>
    </template>
    <UAlert
      v-if="status.isError.value"
      color="error"
      variant="subtle"
      :title="status.error.value instanceof ApiError ? status.error.value.message : '读取失败'"
    />
    <div v-else-if="status.data.value" class="space-y-3">
      <div class="flex items-baseline gap-2">
        <span class="text-2xl font-semibold tabular-nums">
          {{ status.data.value.active?.embedded ?? 0 }} / {{ status.data.value.eligible }}
        </span>
        <span class="text-sm text-muted">
          {{
            status.data.value.active
              ? `模型 ${status.data.value.active.model}`
              : '还没有配置嵌入模型'
          }}
        </span>
      </div>
      <UProgress
        v-if="status.data.value.active && percent(status.data.value.active.embedded) !== null"
        :model-value="percent(status.data.value.active.embedded)!"
      />
      <UAlert
        v-if="errorOf(status.data.value.active?.model)"
        color="error"
        variant="subtle"
        :title="errorOf(status.data.value.active?.model)!.message"
      />
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          :icon="icons.vector"
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
        <span v-if="polling || next" class="text-sm text-muted">正在跟进进度……</span>
      </div>
    </div>
  </UCard>

  <UModal :open="confirmStart" title="开始换模型？" @update:open="(v) => (confirmStart = v)">
    <template #body>
      <p class="text-sm">
        后台会为全部记忆生成 {{ nextModel }} 的向量，会请求很多次新的接口。补齐之前召回一直用
        {{ active?.model }}，补齐后自动切过去。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="confirmStart = false">取消</UButton>
        <UButton :loading="savingNext" @click="saveNext">开始</UButton>
      </div>
    </template>
  </UModal>
  <UModal :open="confirmSwitch" title="现在就切换？" @update:open="(v) => (confirmSwitch = v)">
    <template #body>
      <p class="text-sm">
        <template v-if="remaining">
          还有 {{ remaining }} 条记忆没有
          {{ next?.model }} 的向量，切过去之后它们暂时只能靠全文与关键词召回，后台会接着补。
        </template>
        <template v-else>切到 {{ next?.model }}。</template>
        {{ active?.model }} 的向量会被删掉。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="confirmSwitch = false">取消</UButton>
        <UButton :loading="switching" @click="switchNow">切换</UButton>
      </div>
    </template>
  </UModal>
  <UModal :open="confirmAbort" title="放弃换模型？" @update:open="(v) => (confirmAbort = v)">
    <template #body>
      <p class="text-sm">删掉 {{ next?.model }} 已经生成的向量，召回继续用 {{ active?.model }}。</p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="confirmAbort = false">取消</UButton>
        <UButton color="error" :loading="aborting" @click="abort">放弃</UButton>
      </div>
    </template>
  </UModal>
</template>
