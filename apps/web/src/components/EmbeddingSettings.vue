<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import type {
  EmbeddingChannelTest,
  EmbeddingSetupView,
  EmbeddingTestResult,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'

import { ApiError, readFailure } from '../api/client'
import { api } from '../api/endpoints'
import {
  draftOf,
  draftsChanged,
  followEmbedding,
  inputOf,
  switchTracker,
  type ChannelDraft,
} from '../embeddingDrafts'
import { needsNewKey } from '../endpointKey'
import { icons } from '../icons'
import EmbeddingChannels from './EmbeddingChannels.vue'
import Hint from './Hint.vue'
import NoteLine from './strata/NoteLine.vue'
import SettingsBlock from './strata/SettingsBlock.vue'
import SettingsColumns from './strata/SettingsColumns.vue'

// 有没有没保存的修改：切到别的小节之后表单看不见了，交给页面在子导航上标出来
const dirtyModel = defineModel<boolean>('dirty', { default: false })

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

// 进度刷不刷只看进度本身（见 followEmbedding）：换模型、补齐时一直跟着，补齐了就停。
// 保存、切换、补齐之后都会重新读一次进度，读到还没补齐就接着刷
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
      toast.add({ title: '嵌入设置已在后台更新，未保存的渠道改动已丢弃', color: 'warning' })
    }
  },
  { immediate: true },
)
const activeDirty = computed(() =>
  active.value
    ? draftsChanged(activeDrafts.value, active.value.channels)
    : modelId.value !== '' || activeDrafts.value.some((d) => d.baseUrl || d.model || d.apiKey),
)
// 有渠道换了接口主机、又没说 Key 怎么处理（见 needsNewKey）：服务端会拒，提交之前就拦下，
// 按钮旁边说一句，具体的说明在那个渠道的 Key 旁边
const KEY_MISSING = '有渠道更换了接口主机，请重新填写或清除其 Key'
const activeKeyMissing = computed(() => activeDrafts.value.some(needsNewKey))
const saving = ref(false)
async function saveActive() {
  if (activeKeyMissing.value) return
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
      title: first ? '已保存，后台将为全部记忆生成向量' : '已保存',
      color: 'success',
    })
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
    if (discarded) {
      toast.add({ title: '更换模型的设置已在后台更新，未保存的渠道改动已丢弃', color: 'warning' })
    }
  },
  { immediate: true },
)

// 换模型结束（补齐后自动切过去、现在切换或放弃）的提示，只给这个页面开着时读到的变化（见 switchTracker）。
// ending 是这个页面自己点的「立即切换」「放弃」：放弃由点的地方提示，进度也已经跟着设置一起重新读了
const sawSwitch = switchTracker()
let ending: 'switch' | 'abort' | null = null
watch(
  () => settings.dataUpdatedAt.value,
  () => {
    const ended = sawSwitch(settings.isFetchedAfterMount.value, next.value, active.value)
    if (!ended) return
    const own = ending !== null
    ending = null
    // 后台结束的（设置的轮询发现的）：进度可能还停在换模型的时候，读一次；正在读的就等它，不重发
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
  nextDrafts.value = (active.value?.channels ?? []).map((c) => ({ ...draftOf(c), model: '' }))
  starting.value = true
}
const nextDirty = computed(() =>
  next.value
    ? draftsChanged(nextDrafts.value, next.value.channels)
    : starting.value && nextModel.value !== '',
)
// 换模型时照抄现在的渠道，改了接口主机的也要先说 Key 怎么处理，不要等点了确认框里的「开始」才报错
const nextKeyMissing = computed(() => nextDrafts.value.some(needsNewKey))
const confirmStart = ref(false)
function askStart() {
  if (!nextKeyMissing.value) confirmStart.value = true
}
const savingNext = ref(false)
async function saveNext() {
  if (nextKeyMissing.value) {
    confirmStart.value = false
    return
  }
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

// 马上再补一遍新模型的向量（例如修好了渠道之后），不用等定时任务
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

// 「测试连接」测的是已保存的设置：有没保存的改动时先保存再测，改动之后旧的测试结果也不再显示
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
    // 重新读一次进度：缺向量的话就接着刷到补齐
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
        OpenAI 兼容的 /embeddings 接口，须支持 dimensions 参数，向量维度固定为
        {{ settings.data.value?.dimensions ?? 1024 }}。
        <Hint>
          整个实例共用一个模型。可配置多个渠道（同一模型的不同接口），按顺序请求，前一个出错时切换到下一个。
        </Hint>
      </template>
      <!-- 后台刷新失败时读到过的设置留着，错误放在上面 -->
      <NoteLine v-if="settings.isError.value" tone="error">
        {{ readFailure(settings.error.value) }}
      </NoteLine>
      <!--
        没读到过设置时不给表单：空表单会被当成第一次配置，保存就盖掉了读不到的那份。
        重新读取时错误会被清掉，所以只看有没有数据
      -->
      <USkeleton v-if="settings.isPending.value" class="h-40 w-full" />
      <form v-else-if="settings.data.value" class="space-y-4" @submit.prevent="saveActive">
        <UFormField
          label="模型标识"
          :help="
            active
              ? '向量按此标识存储；更换模型请使用下方的「更换模型」。'
              : '向量按此标识存储，例如模型名称。'
          "
        >
          <UInput v-model="modelId" class="w-full font-mono" :disabled="!!active" required />
        </UFormField>
        <EmbeddingChannels v-model="activeDrafts" />
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            type="submit"
            color="primary"
            variant="outline"
            :loading="saving"
            :disabled="!activeDirty || activeKeyMissing"
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
          <span v-if="activeKeyMissing" class="text-error">{{ KEY_MISSING }}</span>
          <span v-else-if="active && (activeDirty || nextDirty)" class="text-muted"
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
          <EmbeddingChannels v-model="nextDrafts" />
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              type="submit"
              color="primary"
              variant="outline"
              :loading="savingNext"
              :disabled="!nextDirty || nextKeyMissing"
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
            <span v-if="nextKeyMissing" class="text-error">{{ KEY_MISSING }}</span>
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
        <EmbeddingChannels v-model="nextDrafts" />
        <div class="flex flex-wrap items-center gap-2">
          <UButton type="submit" color="primary" variant="outline" :disabled="nextKeyMissing"
            >开始更换模型</UButton
          >
          <UButton color="neutral" variant="ghost" @click="starting = false">取消</UButton>
          <span v-if="nextKeyMissing" class="text-error">{{ KEY_MISSING }}</span>
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
        <!-- 后台刷新失败时读到过的进度留着，错误放在上面 -->
        <NoteLine v-if="status.isError.value" tone="error">
          {{ readFailure(status.error.value) }}
        </NoteLine>
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

  <UModal :open="confirmStart" title="开始更换模型？" @update:open="(v) => (confirmStart = v)">
    <template #body>
      <p class="text-sm">
        后台将为全部记忆生成 {{ nextModel }} 的向量，产生大量接口请求。补齐前召回继续使用
        {{ active?.model }}，补齐后自动切换并删除旧模型的向量。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="confirmStart = false">取消</UButton>
        <UButton :loading="savingNext" @click="saveNext">开始</UButton>
      </div>
    </template>
  </UModal>
  <UModal :open="confirmSwitch" title="立即切换？" @update:open="(v) => (confirmSwitch = v)">
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
        <UButton color="neutral" variant="ghost" @click="confirmSwitch = false">取消</UButton>
        <UButton :loading="switching" @click="switchNow">切换</UButton>
      </div>
    </template>
  </UModal>
  <UModal :open="confirmAbort" title="放弃更换模型？" @update:open="(v) => (confirmAbort = v)">
    <template #body>
      <p class="text-sm">
        {{ next?.model }} 已生成的向量将被删除，召回继续使用 {{ active?.model }}。
      </p>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="confirmAbort = false">取消</UButton>
        <UButton color="error" :loading="aborting" @click="abort">放弃</UButton>
      </div>
    </template>
  </UModal>
</template>
