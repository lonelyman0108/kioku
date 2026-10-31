<script setup lang="ts">
import { useToast } from '@nuxt/ui/composables'
import {
  LAYERS,
  SENSITIVITIES,
  type CreatedKey,
  type KeyInfo,
  type KeyScopes,
} from '@kioku/contracts'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, reactive, ref, toRef, watch } from 'vue'

import { ApiError } from '../api/client'
import { api } from '../api/endpoints'
import { effectiveNote } from '../apps'
import { useCopy } from '../composables/useCopy'
import { useKeyMatrices } from '../composables/useKeyMatrices'
import { icons } from '../icons'
import { ADMIN_SCOPE_LABEL, layerLabels, scopesSummary, sensitivityLabels } from '../labels'
import { formatRelative, formatShort, formatTime } from '../time'
import { keyPresets } from './keyPresets'
import NoteLine from './strata/NoteLine.vue'
import SectionHeading from './strata/SectionHeading.vue'
import StrataCore from './strata/StrataCore.vue'

const props = defineProps<{
  spaceId: string
  appId: string
  isAppOwner: boolean
  // 签发还要求应用所有者在空间里是所有者或编辑者；列表与吊销只看归属，被降级的所有者仍能吊销泄露的 Key
  canIssue: boolean
  isSpaceOwner: boolean
  // 右边权限范围看的是哪个 Key
  selected: string | null
}>()
const emit = defineEmits<{ select: [keyId: string] }>()
const toast = useToast()
const queryClient = useQueryClient()
const queryKey = computed(() => ['keys', props.spaceId, props.appId])

// 只有应用所有者和空间所有者能看 Key 列表
const keys = useQuery({
  queryKey,
  queryFn: () => api.keys(props.spaceId, props.appId),
  enabled: computed(() => props.isAppOwner || props.isSpaceOwner),
})
const live = computed(() => (keys.data.value ?? []).filter((key) => !key.revokedAt))
const revoked = computed(() => (keys.data.value ?? []).filter((key) => key.revokedAt))
// 每个还有效的 Key 一根岩芯，画的是无上下文时的实际范围
const { rowsOf } = useKeyMatrices(
  toRef(props, 'spaceId'),
  computed(() =>
    live.value
      .filter((key) => key.effectiveScopes)
      .map((key) => ({ appId: props.appId, keyId: key.id })),
  ),
)

const issueOpen = ref(false)
const issued = ref<CreatedKey | null>(null)
const form = reactive({
  name: '',
  preset: 'agent',
  advanced: false,
  scopes: { ...keyPresets[0]!.scopes } as KeyScopes,
})
const layerItems = LAYERS.map((l) => ({ label: layerLabels[l], value: l }))
// 编辑者无法签发机密级和跨人格写入的 Key，选项里也不给
const sensitivityItems = computed(() =>
  SENSITIVITIES.filter((s) => props.isSpaceOwner || s !== 'secret').map((s) => ({
    label: sensitivityLabels[s],
    value: s,
  })),
)

function pickPreset(id: string) {
  form.preset = id
  const preset = keyPresets.find((p) => p.id === id)
  if (preset)
    form.scopes = {
      ...preset.scopes,
      readLayers: [...preset.scopes.readLayers],
      writeLayers: [...preset.scopes.writeLayers],
    }
}

// 签发中不接受第二次提交：连点两次会签出两个 Key，只有后一个的明文被展示
const issuing = ref(false)
async function issue() {
  if (issuing.value) return
  issuing.value = true
  try {
    issued.value = await api.createKey(props.spaceId, props.appId, {
      name: form.name || form.preset,
      scopes: form.scopes,
    })
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
    // 右边跟着看新签发的这个
    emit('select', issued.value.id)
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '签发失败', color: 'error' })
  } finally {
    issuing.value = false
  }
}

// 关掉「逐项调整」时回到所选预设的权限，不让看不见的改动跟着签出去
watch(
  () => form.advanced,
  (on) => {
    if (!on) pickPreset(form.preset)
  },
)

function closeIssue() {
  issueOpen.value = false
  issued.value = null
  form.name = ''
  form.advanced = false
  pickPreset(form.preset)
}

// 剪贴板接口只在 HTTPS 或 localhost 下可用；用局域网 HTTP 地址打开时提示手动复制
const copyText = useCopy()
const copy = (text: string) => copyText(text, '浏览器不允许自动复制，请手动选中 Key 后复制')

const revoking = ref<KeyInfo | null>(null)
async function revoke() {
  if (!revoking.value) return
  try {
    await api.revokeKey(props.spaceId, props.appId, revoking.value.id)
    revoking.value = null
    await queryClient.invalidateQueries({ queryKey: queryKey.value })
    toast.add({ title: 'Key 已吊销', color: 'success' })
  } catch (err) {
    toast.add({ title: err instanceof ApiError ? err.message : '吊销失败', color: 'error' })
  }
}
</script>

<template>
  <section class="app-keys">
    <SectionHeading title="API Key">
      <template v-if="canIssue" #actions>
        <UButton size="sm" color="primary" variant="outline" @click="issueOpen = true">
          签发 Key
        </UButton>
      </template>
    </SectionHeading>
    <p v-if="!isAppOwner && !isSpaceOwner" class="keys-empty">仅应用所有者可查看和签发 Key</p>
    <template v-else>
      <NoteLine v-if="keys.isError.value && !keys.data.value" class="keys-failed" tone="error">
        {{ keys.error.value instanceof ApiError ? keys.error.value.message : '读取失败' }}
      </NoteLine>
      <USkeleton v-else-if="keys.isPending.value" class="mt-3 h-24 w-full" />
      <p v-else-if="!keys.data.value?.length" class="keys-empty">暂无 Key</p>
      <ul>
        <li v-for="key in live" :key="key.id" class="key-row" :class="{ on: key.id === selected }">
          <!-- 已作废的 Key 没有权限范围可看，只能吊销 -->
          <component
            :is="key.effectiveScopes ? 'button' : 'div'"
            class="key-main"
            :type="key.effectiveScopes ? 'button' : undefined"
            :aria-pressed="key.effectiveScopes ? key.id === selected : undefined"
            @click="key.effectiveScopes && emit('select', key.id)"
          >
            <StrataCore
              :rows="rowsOf(key.id)"
              :label="`${key.name} 无上下文时`"
              :width="44"
              :height="72"
            />
            <span class="key-text">
              <b>{{ key.name }}</b>
              <code>{{ key.prefix }}</code>
              <span>签发范围：{{ scopesSummary(key.scopes) }}</span>
              <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                最近使用 {{ formatRelative(key.lastUsedAt) }}
              </span>
              <span v-else>尚未使用</span>
              <span v-if="effectiveNote(key)" class="key-note">{{ effectiveNote(key) }}</span>
            </span>
          </component>
          <UButton
            class="key-revoke"
            size="sm"
            color="error"
            variant="outline"
            :aria-label="`吊销 ${key.name}`"
            @click="revoking = key"
          >
            吊销
          </UButton>
        </li>
      </ul>
      <ul v-if="revoked.length" class="keys-revoked">
        <li v-for="key in revoked" :key="key.id" class="key-row revoked">
          <div class="key-main">
            <StrataCore :scopes="key.scopes" revoked :label="key.name" :width="44" :height="72" />
            <span class="key-text">
              <b>{{ key.name }}</b>
              <code>{{ key.prefix }}</code>
              <span :title="formatTime(key.revokedAt!)">
                已吊销 {{ formatShort(key.revokedAt!) }}
              </span>
              <span v-if="key.lastUsedAt" :title="formatTime(key.lastUsedAt)">
                最近使用 {{ formatShort(key.lastUsedAt) }}
              </span>
            </span>
          </div>
        </li>
      </ul>
    </template>

    <!-- 明文 Key 显示期间不能点遮罩、按 Esc 或右上角关掉，只能点「我已保存」，免得没复制就丢了 -->
    <UModal
      :open="issueOpen"
      title="签发 API Key"
      :dismissible="!issued"
      :close="!issued"
      :ui="{ content: 'sm:max-w-2xl' }"
      @update:open="(v) => (v ? (issueOpen = true) : closeIssue())"
    >
      <template #body>
        <div v-if="issued" class="space-y-3">
          <NoteLine tone="warning">Key 只显示这一次，关闭后无法再次查看，请立即保存。</NoteLine>
          <div class="once">
            <code>{{ issued.key }}</code>
            <UButton
              :icon="icons.copy"
              color="primary"
              variant="outline"
              aria-label="复制"
              @click="copy(issued.key)"
            />
          </div>
        </div>
        <div v-else class="issue">
          <form id="issue-key" class="space-y-4" @submit.prevent="issue">
            <UFormField label="名称" help="用于辨认 Key，例如「MacBook 上的 Claude Code」">
              <UInput v-model="form.name" class="w-full" />
            </UFormField>
            <UFormField label="权限">
              <div class="space-y-2">
                <URadioGroup
                  :model-value="form.preset"
                  :items="
                    keyPresets.map((p) => ({ label: p.label, description: p.help, value: p.id }))
                  "
                  @update:model-value="(v) => pickPreset(String(v))"
                />
                <USwitch v-model="form.advanced" label="逐项调整" />
              </div>
            </UFormField>
            <template v-if="form.advanced">
              <UFormField label="可读层">
                <USelect
                  v-model="form.scopes.readLayers"
                  :items="layerItems"
                  multiple
                  class="w-full"
                />
              </UFormField>
              <UFormField label="可写层">
                <USelect
                  v-model="form.scopes.writeLayers"
                  :items="layerItems"
                  multiple
                  class="w-full"
                />
              </UFormField>
              <UFormField label="最高敏感级">
                <USelect
                  v-model="form.scopes.maxSensitivity"
                  :items="sensitivityItems"
                  class="w-full"
                />
              </UFormField>
              <USwitch
                v-if="isSpaceOwner"
                v-model="form.scopes.admin"
                :label="`${ADMIN_SCOPE_LABEL}：可写入任意人格与应用命名空间下的记忆`"
              />
            </template>
          </form>
          <aside class="issue-preview">
            <StrataCore :scopes="form.scopes" :width="64" :height="108" />
            <p>{{ scopesSummary(form.scopes) }}</p>
          </aside>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton v-if="issued" @click="closeIssue">我已保存</UButton>
          <template v-else>
            <UButton color="neutral" variant="ghost" @click="closeIssue">取消</UButton>
            <UButton type="submit" form="issue-key" :loading="issuing">签发</UButton>
          </template>
        </div>
      </template>
    </UModal>

    <UModal
      :open="revoking !== null"
      title="吊销这个 Key？"
      @update:open="(v) => !v && (revoking = null)"
    >
      <template #body>
        <p class="text-sm">
          吊销 <code>{{ revoking?.prefix }}</code
          >（{{ revoking?.name }}）后，使用它的客户端将立即失去访问权限。
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" @click="revoking = null">取消</UButton>
          <UButton color="error" @click="revoke">吊销</UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
.keys-empty {
  padding: 14px 0;
  color: var(--ui-text-muted);
}
.note-line.keys-failed {
  margin: 10px 0 0;
  border-top: 0;
}
.key-row {
  position: relative;
  border-bottom: 1px solid var(--ui-border);
}
.key-main {
  display: flex;
  gap: 14px;
  width: 100%;
  padding: 11px 64px 11px 10px;
  text-align: left;
}
button.key-main:hover {
  background: var(--ui-bg-muted);
}
button.key-main:focus-visible {
  outline-offset: -2px;
}
.key-row.on .key-main {
  --strata-frame: var(--strata-selected-frame);
  background: var(--strata-selected);
  color: var(--strata-on-selected);
}
.key-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--ui-text-muted);
  overflow-wrap: anywhere;
}
.key-text b {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.key-text code {
  font-size: 13px;
  color: var(--ui-text);
}
.key-note {
  color: var(--ui-warning);
}
.key-row.on .key-text {
  color: var(--strata-on-selected-muted);
}
.key-row.on .key-text b,
.key-row.on .key-text code,
.key-row.on .key-note {
  color: var(--strata-on-selected);
}
.key-revoke {
  position: absolute;
  top: 10px;
  right: 8px;
  background: var(--ui-bg);
}
.key-revoke:hover {
  background: var(--ui-bg);
}
.keys-revoked {
  margin-top: -1px;
  border-top: 1px dashed var(--ui-border-accented);
}
.key-row.revoked .key-main {
  padding-right: 10px;
}
.key-row.revoked b {
  font-weight: 500;
  color: var(--ui-text-muted);
}
.once {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.once code {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--strata-rule);
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.issue {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 148px;
  gap: 24px;
}
.issue-preview {
  padding-left: 20px;
  border-left: 1px solid var(--ui-border);
}
.issue-preview p {
  margin-top: 10px;
  font-size: 14px;
  line-height: 1.65;
  color: var(--ui-text-muted);
}
@media (max-width: 640px) {
  .issue {
    grid-template-columns: minmax(0, 1fr);
  }
  .issue-preview {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 12px 0 0;
    border-top: 1px solid var(--ui-border);
    border-left: 0;
  }
  .issue-preview p {
    margin-top: 0;
  }
}
</style>
